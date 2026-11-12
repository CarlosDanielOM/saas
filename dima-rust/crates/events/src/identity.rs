//! Stored identities: the event key, the receipt id of a custom goal contribution, the keys of a
//! durable cron-job intent, and the owner of an event.
//!
//! These values are already in the journal and in `cron_job_intents`, so they are computed to
//! the reference's bytes (`MIGRATION.md` section 3, "stored identities"): an event Twitch or
//! Polar delivers again after the cutover must hit the same unique key and be recognised as
//! already journaled. `tests/real_data.rs` recomputes them over the production copy.
//!
//! References: `buildDomainEventKey` (`utils/domain_events.ts`), `customGoalProducer`
//! (`domain_events/goal_custom_events.ts`), `getCronJobDedupeKey` (`utils/cron_jobs_queue.ts`),
//! `durableAutomaticAcceptanceKey` and `activeKey` (`utils/durable_cron_jobs.ts`),
//! `resolveDomainEventOwner` (`domain_events/domain_event_identity.ts`).

use crate::contracts::SubjectKind;
use crate::store::{StoreError, bounded};
use bson::{Bson, Document, doc, oid::ObjectId};
use dima_model::StrEnum;
use dima_store::mongo::MongoStore;
use dima_text::trim;
use std::time::Duration;

/// A blank key component (`Domain event key component is required`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("Domain event key component is required")]
pub struct KeyComponentRequired;

/// `encodeURIComponent(text)`: UTF-8 bytes percent-encoded with upper-case hex, except
/// `A-Z a-z 0-9 - _ . ! ~ * ' ( )`. (JavaScript throws on a lone surrogate, which Rust text
/// cannot hold.)
pub fn encode_uri_component(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    out
}

/// `buildDomainEventKey(source, sourceEventId, type)`: each component trimmed (JavaScript's
/// whitespace set) and `encodeURIComponent`-encoded, joined with `:`.
pub fn event_key(
    source: &str,
    source_event_id: &str,
    kind: &str,
) -> Result<String, KeyComponentRequired> {
    let mut parts = Vec::with_capacity(3);
    for component in [source, source_event_id, kind] {
        let component = trim(component);
        if component.is_empty() {
            return Err(KeyComponentRequired);
        }
        parts.push(encode_uri_component(component));
    }
    Ok(parts.join(":"))
}

/// The `sourceEventId` of a custom goal contribution:
/// `sha256(JSON.stringify([channelID, receiptIdentity])).hex`.
pub fn goal_contribution_id(channel_id: &str, receipt_identity: &str) -> String {
    let json = serde_json::Value::Array(vec![
        serde_json::Value::String(channel_id.to_owned()),
        serde_json::Value::String(receipt_identity.to_owned()),
    ]);
    dima_core::crypto::keys::json_sha256_hex(&json)
}

/// `getCronJobDedupeKey(token)`: `cron:jobs:dedupe:<trimmed token>`.
pub fn cron_dedupe_key(token: &str) -> String {
    dima_store::dragonfly::cron_queue::get_cron_job_dedupe_key(token)
}

/// `durableAutomaticAcceptanceKey(job)`: `cron:jobs:accepted:<job>:<channel>:<session>` for a
/// job whose `data.source` is `stream_offline` with a non-blank `data.sessionID` and channel;
/// `None` otherwise. `job` is the job name as stored (not trimmed again).
pub fn automatic_acceptance_key(
    job: &str,
    channel_id: Option<&str>,
    data_source: Option<&serde_json::Value>,
    session_id: Option<&serde_json::Value>,
) -> Option<String> {
    let session = session_id
        .and_then(serde_json::Value::as_str)
        .map(trim)
        .unwrap_or("");
    let channel = channel_id.map(trim).unwrap_or("");
    if data_source.and_then(serde_json::Value::as_str) != Some("stream_offline")
        || session.is_empty()
        || channel.is_empty()
    {
        return None;
    }
    Some(format!("cron:jobs:accepted:{job}:{channel}:{session}"))
}

/// `activeKey(job, queueKey)`: `<queueKey>\0<dedupeKey>`, or `<queueKey>\0job:<id>` for a job
/// without a dedupe key (an empty one counts as none).
pub fn intent_active_key(queue_key: &str, dedupe_key: Option<&str>, job_id: &str) -> String {
    match dedupe_key.filter(|key| !key.is_empty()) {
        Some(key) => format!("{queue_key}\u{0}{key}"),
        None => format!("{queue_key}\u{0}job:{job_id}"),
    }
}

/// `/^[a-f\d]{24}$/i`: an internal user id.
pub fn is_user_id(text: &str) -> bool {
    text.len() == 24 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// `resolveDomainEventOwner(subject, externalOwnerId, legacyTwitchChannelId)`: the `users._id`
/// (hex) owning a subject, read from MongoDB. The source adapter supplies a provider-verified
/// external customer id, never arbitrary user input.
///
/// - `streaming-account`: the user with an account of that provider and id.
/// - Polar `customer`: the user linked to the customer; else the user named by the external id
///   when it is not linked to another customer; else (legacy) the Twitch account of the channel
///   when that user is unlinked or linked to this customer.
/// - Anything else: no owner (integrations need their own lookups; ownership is never inferred
///   from a channel).
pub async fn resolve_owner(
    store: &MongoStore,
    deadline: Duration,
    subject_provider: &str,
    subject_kind: &str,
    subject_id: &str,
    external_owner_id: Option<&str>,
    legacy_twitch_channel_id: Option<&str>,
) -> Result<Option<String>, StoreError> {
    let users = store.documents(dima_model::users::COLLECTION);
    let first_id = |filter: Document| {
        let users = users.clone();
        async move {
            bounded(
                "resolve the event owner",
                deadline,
                users.find_one(filter).projection(doc! { "_id": 1 }),
            )
            .await
            .map(|found| found.and_then(|user| id_text(user.get("_id"))))
        }
    };
    if subject_kind == SubjectKind::StreamingAccount.as_str() {
        return first_id(doc! {
            "accounts": { "$elemMatch": { "type": subject_provider, "id": subject_id } }
        })
        .await;
    }
    if subject_kind == SubjectKind::Customer.as_str() && subject_provider == "polar" {
        if let Some(linked) = first_id(doc! { "polar_sh_customer_id": subject_id }).await? {
            return Ok(Some(linked));
        }
        if let Some(external) = external_owner_id.filter(|id| is_user_id(id)) {
            let id = ObjectId::parse_str(external.to_ascii_lowercase()).ok();
            let Some(id) = id else { return Ok(None) };
            let user = bounded(
                "resolve the event owner",
                deadline,
                users
                    .find_one(doc! { "_id": id })
                    .projection(doc! { "_id": 1, "polar_sh_customer_id": 1 }),
            )
            .await?;
            return Ok(user.and_then(|user| {
                let linked = match user.get("polar_sh_customer_id") {
                    Some(Bson::String(customer)) => customer.as_str(),
                    _ => "",
                };
                (linked.is_empty() || linked == subject_id)
                    .then(|| id_text(user.get("_id")))
                    .flatten()
            }));
        }
        if let Some(channel) = legacy_twitch_channel_id.filter(|c| !c.is_empty()) {
            return first_id(doc! {
                "accounts": { "$elemMatch": { "type": "twitch", "id": channel } },
                "$or": [
                    { "polar_sh_customer_id": Bson::Null },
                    { "polar_sh_customer_id": "" },
                    { "polar_sh_customer_id": subject_id },
                ],
            })
            .await;
        }
        return Ok(None);
    }
    Ok(None)
}

/// `user._id.toString()`.
fn id_text(id: Option<&Bson>) -> Option<String> {
    match id? {
        Bson::ObjectId(id) => Some(id.to_hex()),
        Bson::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_keys() {
        assert_eq!(
            event_key("twitch-eventsub", "-3zzqD0yswolijfLdgpN93W8FWC2vkAFtgSxfolPYs4=", "channel.subscription.received"),
            Ok("twitch-eventsub:-3zzqD0yswolijfLdgpN93W8FWC2vkAFtgSxfolPYs4%3D:channel.subscription.received".into())
        );
        assert_eq!(
            event_key("a:b", " c/d ", "e f"),
            Ok("a%3Ab:c%2Fd:e%20f".into())
        );
        assert_eq!(
            event_key("\u{feff}s\u{a0}", "é👋", "t"),
            Ok("s:%C3%A9%F0%9F%91%8B:t".into())
        );
        // U+0085 is not JavaScript whitespace.
        assert_eq!(event_key("\u{85}", "x", "t"), Ok("%C2%85:x:t".into()));
        assert_eq!(event_key("s", " \n", "t"), Err(KeyComponentRequired));
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
    }

    #[test]
    fn goal_contribution_ids_hash_js_json() {
        // sha256('["123","[\"origin\",\"chat\",\"m\",\"a\"]"]')
        let receipt = r#"["origin","chat","m","a"]"#;
        let expected = dima_core::crypto::sha256(format!(
            "[\"123\",{}]",
            serde_json::to_string(receipt).unwrap_or_default()
        ))
        .hex();
        assert_eq!(goal_contribution_id("123", receipt), expected);
    }

    #[test]
    fn cron_keys() {
        assert_eq!(cron_dedupe_key(" a:b "), "cron:jobs:dedupe:a:b");
        assert_eq!(
            intent_active_key("q", Some("cron:jobs:dedupe:x"), "id"),
            "q\u{0}cron:jobs:dedupe:x"
        );
        assert_eq!(intent_active_key("q", Some(""), "id"), "q\u{0}job:id");
        let offline = serde_json::json!("stream_offline");
        let session = serde_json::json!(" s1 ");
        assert_eq!(
            automatic_acceptance_key(
                "stream-memory-summary",
                Some("42"),
                Some(&offline),
                Some(&session)
            ),
            Some("cron:jobs:accepted:stream-memory-summary:42:s1".into())
        );
        assert_eq!(
            automatic_acceptance_key("j", Some(" "), Some(&offline), Some(&session)),
            None
        );
        assert!(is_user_id("693B4cc2e046b90ea3c06ebe"));
        assert!(!is_user_id("693b4cc2e046b90ea3c06eb"));
    }
}

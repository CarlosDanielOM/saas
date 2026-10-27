use std::collections::{BTreeMap, HashMap};

use mongodb::bson::{DateTime, Document, doc, oid::ObjectId};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(super) const COUNTERS: &[&str] = &[
    "count",
    "messages",
    "commands",
    "emotes",
    "emoteMessages",
    "chatters",
    "failures",
    "redemptions",
    "follows",
    "subs",
    "bits",
    "raids",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Activity {
    #[serde(rename = "channelID")]
    pub channel_id: String,
    #[serde(rename = "session_id")]
    pub session_id: ObjectId,
    pub occurred_at: DateTime,
    pub expires_at: DateTime,
    pub kind: String,
    pub offset: Option<f64>,
    pub key: Option<String>,
    pub label: Option<String>,
    pub actor: Option<String>,
    pub actor_label: Option<String>,
    pub value: Option<f64>,
    pub outcome: Option<String>,
    #[serde(default)]
    pub emotes: Vec<Emote>,
}

#[derive(Debug, Deserialize)]
pub(super) struct Emote {
    key: Option<String>,
    label: Option<String>,
    count: Option<f64>,
}

pub(super) struct Change {
    pub base: Document,
    pub inc: BTreeMap<&'static str, f64>,
    first_at: DateTime,
    message_at: Option<DateTime>,
    expires_at: DateTime,
}

pub(super) struct Projection<'a> {
    pub changes: HashMap<String, Change>,
    pub distinct: HashMap<String, (&'a Activity, i64)>,
}

fn text(value: &Option<String>) -> &str {
    value.as_deref().unwrap_or("")
}

pub(super) fn hash(parts: impl Serialize) -> String {
    // Borrowed tuples serialize as compact arrays, without allocating a JSON
    // Value tree or cloning each string. Integer buckets match JSON.stringify.
    let digest = Sha256::digest(serde_json::to_vec(&parts).expect("identity tuple serializes"));
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 15) as usize] as char);
    }
    encoded
}

fn bucket(row: &Activity) -> i64 {
    (row.offset.unwrap_or(0.0) / 300.0).floor() as i64
}

impl<'a> Projection<'a> {
    pub fn new(rows: &'a [Activity]) -> Self {
        let mut projection = Self {
            changes: HashMap::new(),
            distinct: HashMap::new(),
        };
        for row in rows {
            let actor = text(&row.actor);
            if row.kind == "message" && !actor.is_empty() && actor != "698614112" {
                let bucket = bucket(row);
                let id = hash((
                    row.channel_id.as_str(),
                    row.session_id.to_hex(),
                    "distinct",
                    actor,
                    bucket,
                ));
                // As in the JS Map, the last row supplies the receipt's metadata.
                projection.distinct.insert(id, (row, bucket));
            }
        }
        projection
    }

    #[allow(clippy::too_many_arguments)]
    fn add(
        &mut self,
        row: &Activity,
        scope: &str,
        kind: &str,
        key: &str,
        actor: &str,
        bucket: i64,
        inc: &[(&'static str, f64)],
        label: &str,
    ) {
        let id = hash((
            row.channel_id.as_str(),
            row.session_id.to_hex(),
            scope,
            kind,
            key,
            actor,
            bucket,
        ));
        let item = self.changes.entry(id).or_insert_with(|| Change {
            base: doc! { "channelID": &row.channel_id, "session_id": row.session_id,
            "scope": scope, "kind": kind, "key": key, "actor": actor,
            "bucket": bucket, "label": label },
            inc: BTreeMap::new(),
            first_at: row.occurred_at,
            message_at: None,
            expires_at: row.expires_at,
        });
        for &(name, value) in inc {
            *item.inc.entry(name).or_default() += value;
        }
        item.first_at = item.first_at.min(row.occurred_at);
        if row.kind == "message" {
            item.message_at = Some(
                item.message_at
                    .map_or(row.occurred_at, |at| at.min(row.occurred_at)),
            );
        }
        item.expires_at = item.expires_at.max(row.expires_at);
    }

    pub fn add_chatter(&mut self, id: &str) {
        if let Some(&(row, bucket)) = self.distinct.get(id) {
            self.add(row, "chart", "", "", "", bucket, &[("chatters", 1.0)], "");
        }
    }

    pub fn add_rows(&mut self, rows: &[Activity]) {
        let mut metric = Vec::with_capacity(3);
        for row in rows {
            metric.clear();
            let actor = text(&row.actor);
            let actor_label = if text(&row.actor_label).is_empty() {
                actor
            } else {
                text(&row.actor_label)
            };
            match row.kind.as_str() {
                "message" => {
                    metric.extend([
                        ("messages", 1.0),
                        (
                            "emotes",
                            row.emotes
                                .iter()
                                .map(|emote| emote.count.unwrap_or(0.0))
                                .sum(),
                        ),
                        (
                            "emoteMessages",
                            if row.emotes.is_empty() { 0.0 } else { 1.0 },
                        ),
                    ]);
                    for emote in &row.emotes {
                        let inc = [("count", emote.count.unwrap_or(0.0)), ("messages", 1.0)];
                        self.add(
                            row,
                            "rank",
                            "emote",
                            text(&emote.key),
                            "",
                            -1,
                            &inc,
                            text(&emote.label),
                        );
                        if !actor.is_empty() {
                            self.add(
                                row,
                                "actor",
                                "emote",
                                text(&emote.key),
                                actor,
                                -1,
                                &inc,
                                actor_label,
                            );
                        }
                    }
                }
                "command" => {
                    metric.push(("commands", 1.0));
                    let inc = [
                        ("count", 1.0),
                        (
                            "failures",
                            if text(&row.outcome) == "error" {
                                1.0
                            } else {
                                0.0
                            },
                        ),
                    ];
                    let label = if text(&row.label).is_empty() {
                        text(&row.key)
                    } else {
                        text(&row.label)
                    };
                    self.add(row, "rank", "command", text(&row.key), "", -1, &inc, label);
                    if !actor.is_empty() {
                        self.add(
                            row,
                            "actor",
                            "command",
                            text(&row.key),
                            actor,
                            -1,
                            &inc,
                            actor_label,
                        );
                    }
                }
                kind => {
                    let name = match kind {
                        "redemption" => Some("redemptions"),
                        "follow" => Some("follows"),
                        "sub" | "gift" => Some("subs"),
                        "bits" => Some("bits"),
                        "raid" => Some("raids"),
                        _ => None,
                    };
                    if let Some(name) = name {
                        metric.push((
                            name,
                            if kind == "raid" {
                                1.0
                            } else {
                                row.value.unwrap_or(1.0)
                            },
                        ));
                    }
                }
            }
            self.add(row, "chart", "", "", "", bucket(row), &metric, "");
            self.add(row, "summary", "", "", "", -1, &metric, "");
        }
    }
}

/// Mongoose's insert defaults, excluding paths changed by other operators.
pub(super) fn defaults(base: &mut Document, increments: &BTreeMap<&str, f64>, set_last_seq: bool) {
    for &name in COUNTERS {
        if !increments.contains_key(name) {
            base.insert(name, 0);
        }
    }
    if !set_last_seq {
        base.insert("lastSeq", 0);
    }
    if !base.contains_key("key") {
        base.insert("key", "");
    }
    if !base.contains_key("actor") {
        base.insert("actor", "");
    }
    if !base.contains_key("bucket") {
        base.insert("bucket", -1);
    }
}

impl Change {
    pub fn update(mut self, seq: f64, now: DateTime) -> Document {
        defaults(&mut self.base, &self.inc, true);
        let mut min = doc! { "firstAt": self.first_at };
        if let Some(at) = self.message_at {
            min.insert("messageStartedAt", at);
        }
        let inc: Document = self
            .inc
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value.into()))
            .collect();
        doc! { "$setOnInsert": self.base, "$inc": inc,
        "$set": { "lastSeq": seq, "updatedAt": now }, "$min": min,
        "$max": { "expiresAt": self.expires_at } }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(kind: &str, actor: &str, offset: f64, occurred: i64, expires: i64) -> Activity {
        mongodb::bson::deserialize_from_document(doc! {
            "channelID": "123", "session_id": ObjectId::parse_str("0123456789abcdef01234567").unwrap(),
            "kind": kind, "actor": actor, "offset": offset,
            "occurredAt": DateTime::from_millis(occurred), "expiresAt": DateTime::from_millis(expires),
            "emotes": []
        }).unwrap()
    }

    fn find<'a>(projection: &'a Projection<'_>, scope: &str, kind: &str) -> &'a Change {
        projection
            .changes
            .values()
            .find(|change| {
                change.base.get_str("scope").ok() == Some(scope)
                    && change.base.get_str("kind").ok() == Some(kind)
            })
            .unwrap()
    }

    #[test]
    fn hashes_match_node_json_stringify_unicode_and_integer_vectors() {
        assert_eq!(
            hash((
                "123",
                "0123456789abcdef01234567",
                "rank",
                "command",
                "!é😀",
                "",
                -1,
            )),
            "85104363dec1e360cbb299ef077df120103f83d9e11b6e236b667174c40cf9d0"
        );
        assert_eq!(
            hash(("123", "0123456789abcdef01234567", "distinct", "alice", -1,)),
            "7ac9e6fa6557e52189f6be9c1c879bad6bbbf55c89cf612aa5ff29052d6a39b8"
        );
    }

    #[test]
    fn bot_is_excluded_only_from_distinct_and_negative_offsets_floor() {
        let rows = [
            row("message", "alice", -0.01, 100, 200),
            row("message", "alice", -299.0, 90, 300),
            row("message", "698614112", -0.1, 80, 250),
        ];
        let mut projection = Projection::new(&rows);
        assert_eq!(projection.distinct.len(), 1);
        let (id, &(last_row, bucket)) = projection.distinct.iter().next().unwrap();
        assert_eq!(last_row.occurred_at.timestamp_millis(), 90);
        assert_eq!(bucket, -1);
        let id = id.clone();
        projection.add_chatter(&id);
        projection.add_rows(&rows);
        let chart = find(&projection, "chart", "");
        assert_eq!(chart.inc["messages"], 3.0);
        assert_eq!(chart.inc["chatters"], 1.0);
        assert_eq!(chart.first_at.timestamp_millis(), 80);
        assert_eq!(chart.message_at.unwrap().timestamp_millis(), 80);
        assert_eq!(chart.expires_at.timestamp_millis(), 300);
        assert!(
            !find(&projection, "summary", "")
                .inc
                .contains_key("chatters")
        );
    }

    #[test]
    fn commands_emotes_quantities_and_first_label_match_ts() {
        let mut first = row("command", "alice", 0.0, 100, 200);
        first.key = Some("!a".into());
        first.label = Some("First".into());
        first.outcome = Some("error".into());
        let mut second = row("command", "alice", 0.0, 50, 300);
        second.key = Some("!a".into());
        second.label = Some("Second".into());
        let mut message = row("message", "698614112", 0.0, 110, 220);
        message.emotes = vec![Emote {
            key: Some("twitch:1".into()),
            label: Some("Kappa".into()),
            count: Some(3.0),
        }];
        let mut gift = row("gift", "", 300.0, 20, 200);
        gift.value = Some(5.0);
        let sub = row("sub", "", 300.0, 21, 200);
        let mut raid = row("raid", "", 300.0, 22, 200);
        raid.value = Some(100.0);
        let rows = [first, second, message, gift, sub, raid];
        let mut projection = Projection::new(&rows);
        projection.add_rows(&rows);
        let command = find(&projection, "rank", "command");
        assert_eq!(command.inc["count"], 2.0);
        assert_eq!(command.inc["failures"], 1.0);
        assert_eq!(command.base.get_str("label").unwrap(), "First");
        assert_eq!(find(&projection, "rank", "emote").inc["count"], 3.0);
        let summary = find(&projection, "summary", "");
        assert_eq!(summary.inc["subs"], 6.0);
        assert_eq!(summary.inc["raids"], 1.0);
        assert_eq!(summary.inc["emotes"], 3.0);
        assert_eq!(summary.inc["emoteMessages"], 1.0);
        assert_eq!(summary.first_at.timestamp_millis(), 20);
        assert_eq!(summary.message_at.unwrap().timestamp_millis(), 110);
    }

    #[test]
    fn insert_defaults_do_not_conflict_with_update_operators() {
        let rows = [row("message", "alice", 0.0, 100, 200)];
        let mut projection = Projection::new(&rows);
        projection.add_rows(&rows);
        let change = projection.changes.into_values().next().unwrap();
        let update = change.update(7.0, DateTime::from_millis(150));
        let base = update.get_document("$setOnInsert").unwrap();
        for operator in ["$inc", "$set", "$min", "$max"] {
            for key in update.get_document(operator).unwrap().keys() {
                assert!(!base.contains_key(key), "conflicting {key}");
            }
        }
        for &name in COUNTERS {
            assert!(
                base.contains_key(name) || update.get_document("$inc").unwrap().contains_key(name)
            );
        }
        let mut receipt = Document::new();
        defaults(&mut receipt, &BTreeMap::new(), false);
        assert_eq!(receipt.get_i32("lastSeq").unwrap(), 0);
        assert_eq!(receipt.get_i32("bucket").unwrap(), -1);
    }
}

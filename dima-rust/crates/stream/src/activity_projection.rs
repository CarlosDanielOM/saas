use std::collections::{BTreeMap, HashMap};

use bson::{DateTime, Document, doc, oid::ObjectId};
use serde::Deserialize;
use serde_json::json;

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

pub(super) fn hash(parts: serde_json::Value) -> String {
    dima_core::crypto::keys::json_sha256_hex(&parts)
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
                let id = hash(json!([
                    row.channel_id.as_str(),
                    row.session_id.to_hex(),
                    "distinct",
                    actor,
                    bucket,
                ]));
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
        let id = hash(json!([
            row.channel_id.as_str(),
            row.session_id.to_hex(),
            scope,
            kind,
            key,
            actor,
            bucket,
        ]));
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

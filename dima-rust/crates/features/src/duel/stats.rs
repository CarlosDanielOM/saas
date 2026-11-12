//! `duel/stats.ts`: finished overlay fights in `duel_results` (one per run id), the head-to-head
//! record, and the K/D leaderboard.

use std::time::Duration;

use bson::{Bson, Document, doc};
use dima_model::Private;
use dima_model::duel_results::{self as stored, NewDuelResult};
use dima_model::values::Nullable;
use dima_store::mongo::number::{JsNumber, read_number};
use dima_store::mongo::write::WriteError;
use dima_store::mongo::{MongoStore, WriteContext};
use futures_util::TryStreamExt;
use serde_json::{Value, json};

use super::model::{DuelRecord, DuelRun};
use crate::roulette::service::ServiceError;

/// `LEADERBOARD_SIZE`.
pub const LEADERBOARD_SIZE: usize = 10;

/// `DuelRanking`.
#[derive(Clone, Debug, PartialEq)]
pub struct DuelRanking {
    /// The viewer.
    pub login: String,
    /// Wins.
    pub kills: f64,
    /// Losses.
    pub deaths: f64,
    /// Wins ÷ losses (wins alone while unbeaten).
    pub kd: f64,
}

/// `{ players, ranked, duels }`.
#[derive(Clone, Debug, PartialEq)]
pub struct Leaderboard {
    /// The top [`LEADERBOARD_SIZE`].
    pub players: Vec<DuelRanking>,
    /// Ranked viewers (the streamer is not ranked).
    pub ranked: usize,
    /// Recorded fights.
    pub duels: f64,
}

impl Leaderboard {
    /// As the overlay receives it.
    pub fn to_json(&self) -> Value {
        json!({
            "players": self.players.iter().map(|p| json!({"login": p.login, "kills": p.kills, "deaths": p.deaths, "kd": p.kd})).collect::<Vec<_>>(),
            "ranked": self.ranked,
            "duels": self.duels,
        })
    }
}

/// The results store.
#[derive(Clone)]
pub struct DuelStats {
    mongo: MongoStore,
    deadline: Duration,
}

impl DuelStats {
    /// Over `mongo`, each call under `deadline`.
    pub fn new(mongo: MongoStore, deadline: Duration) -> Self {
        Self { mongo, deadline }
    }

    async fn within<T, E: std::fmt::Display>(
        &self,
        what: &str,
        future: impl IntoFuture<Output = Result<T, E>>,
    ) -> Result<T, ServiceError> {
        match tokio::time::timeout(self.deadline, future.into_future()).await {
            Ok(result) => result.map_err(ServiceError::store),
            Err(_) => Err(ServiceError::Store {
                message: format!("{what}: no answer in time"),
                outcome_unknown: true,
            }),
        }
    }

    /// `recordDuelResult(channel, run)`: once per run id (a repeat is a duplicate key, ignored).
    pub async fn record(
        &self,
        channel: &str,
        run: &DuelRun,
        now_ms: i64,
    ) -> Result<(), ServiceError> {
        let streamer = match run.enraged.as_deref() {
            Some("left") => Nullable::Value(Private::from(run.challenger.clone())),
            Some(_) => Nullable::Value(Private::from(run.opponent.clone())),
            None => Nullable::Null,
        };
        let insert = NewDuelResult {
            id: run.id.clone(),
            channel: channel.to_owned(),
            winner: Private::from(run.winner_login().to_owned()),
            loser: Private::from(run.loser_login().to_owned()),
            streamer,
            at: JsNumber(run.ends_at),
        }
        .prepare(&mut WriteContext::new(now_ms))?;
        let mut writes = self.mongo.writes(stored::COLLECTION);
        match tokio::time::timeout(self.deadline, writes.insert_one(&insert)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(WriteError::Driver(error)))
                if dima_store::mongo::error::is_duplicate_key(&error) =>
            {
                Ok(())
            }
            Ok(Err(error)) => Err(error.into()),
            Err(_) => Err(ServiceError::Store {
                message: "duel_results.create: no answer in time".into(),
                outcome_unknown: true,
            }),
        }
    }

    /// `headToHead(channel, left, right)`: each side's wins against the other.
    pub async fn head_to_head(
        &self,
        channel: &str,
        left: &str,
        right: &str,
    ) -> Result<DuelRecord, ServiceError> {
        let collection = self.mongo.documents(stored::COLLECTION);
        let left_wins = self
            .within(
                "duel_results.countDocuments",
                collection
                    .count_documents(doc! { "channel": channel, "winner": left, "loser": right }),
            )
            .await?;
        let right_wins = self
            .within(
                "duel_results.countDocuments",
                collection
                    .count_documents(doc! { "channel": channel, "winner": right, "loser": left }),
            )
            .await?;
        Ok(DuelRecord {
            left: left_wins as f64,
            right: right_wins as f64,
        })
    }

    /// `duelLeaderboard(channel)`: ranked by K/D, then wins, then fewer losses, then the login
    /// in ICU order (`localeCompare`); the streamer is tracked but not ranked.
    pub async fn leaderboard(&self, channel: &str) -> Result<Leaderboard, ServiceError> {
        let one = doc! { "$literal": 1 };
        let zero = doc! { "$literal": 0 };
        let pipeline = vec![
            doc! { "$match": { "channel": channel } },
            doc! { "$project": { "sides": [
                { "login": "$winner", "kills": one.clone(), "deaths": zero.clone(), "streamer": { "$eq": ["$winner", "$streamer"] } },
                { "login": "$loser", "kills": zero, "deaths": one, "streamer": { "$eq": ["$loser", "$streamer"] } },
            ] } },
            doc! { "$unwind": "$sides" },
            doc! { "$group": { "_id": "$sides.login", "kills": { "$sum": "$sides.kills" }, "deaths": { "$sum": "$sides.deaths" }, "streamer": { "$max": "$sides.streamer" } } },
        ];
        let rows: Vec<Document> = self
            .within("duel_results.aggregate", async {
                self.mongo
                    .documents(stored::COLLECTION)
                    .aggregate(pipeline)
                    .await?
                    .try_collect()
                    .await
            })
            .await?;
        let number = |row: &Document, key: &str| row.get(key).and_then(read_number).unwrap_or(0.0);
        let duels = rows.iter().map(|r| number(r, "kills")).sum();
        let mut players: Vec<DuelRanking> = rows
            .iter()
            .filter(|r| r.get_bool("streamer").ok() != Some(true))
            .map(|r| {
                let (kills, deaths) = (number(r, "kills"), number(r, "deaths"));
                DuelRanking {
                    login: match r.get("_id") {
                        Some(Bson::String(login)) => login.clone(),
                        _ => String::new(),
                    },
                    kills,
                    deaths,
                    kd: if deaths != 0.0 { kills / deaths } else { kills },
                }
            })
            .collect();
        let collator = dima_text::Collator::new().ok();
        players.sort_by(|a, b| {
            let by = |x: f64| {
                if x > 0.0 {
                    std::cmp::Ordering::Greater
                } else if x < 0.0 {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Equal
                }
            };
            by(b.kd - a.kd)
                .then(by(b.kills - a.kills))
                .then(by(a.deaths - b.deaths))
                .then_with(|| match &collator {
                    Some(c) => c.compare(&a.login, &b.login),
                    None => a.login.cmp(&b.login),
                })
        });
        let ranked = players.len();
        players.truncate(LEADERBOARD_SIZE);
        Ok(Leaderboard {
            players,
            ranked,
            duels,
        })
    }
}

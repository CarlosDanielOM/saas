//! What an operator does with the recovery records the reconciliation cannot settle alone
//! (review G1 to G3): list them ([`Twitch::recovery_records`]) and settle a named one
//! ([`Twitch::settle_recovery_record`]).
//!
//! # The operator's procedure
//!
//! **Unmatched** (MongoDB holds another token at the record's generation, or two answers of one
//! generation are kept):
//!
//! 1. List the records. Note the streamer id, which keys are unmatched, their generation and
//!    MongoDB's.
//! 2. Usually nothing is needed: the streamer's next refresh tries MongoDB's token and, if
//!    Twitch refuses it, each unmatched answer once; whichever works is written at a higher
//!    generation and the next reconciliation removes the rest. Asking the streamer to sign in
//!    again settles it too (the sign-in quarantines the records).
//! 3. When a decision cannot wait (a rollback): if the streamer's chat and Helix calls work,
//!    MongoDB's token is good, so **discard** the unmatched records; otherwise **apply** one
//!    (for a pair, the record before the side record), then run the reconciliation, which
//!    removes what the new generation supersedes.
//!
//! **Quarantined** (a sign-in superseded the records): nothing is needed. The key expires after
//! 30 days; it is listed for inspection only and is never applied. **Discard** it to remove it
//! sooner, once nobody needs to look at it.
//!
//! **Unreadable** (it blocks the streamer's refreshes): ask the streamer to sign in again
//! (the record goes to the quarantine), or **discard** it (`SECRET_KEY` must be the one that
//! wrote it; a record from another key can never be applied).
//!
//! Each settlement takes an operation id and the operator's name, and is logged at warning
//! level with both (`token_recovery_settled`), never with a token.

use crate::base::{Inner, Twitch};
use crate::credentials::{CAS_ROUNDS, Written, rotation_fields};
use crate::error::TwitchError;
use crate::events::{Destination, Level};
use crate::keys::RecoveryKey;
use crate::recovery::{Record, Verdict};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};

/// Most records one listing returns (an operator's view, not a scan of everything).
pub const MAX_LISTED_RECORDS: usize = 10_000;

/// Longest operation id or operator name a settlement accepts.
const MAX_LABEL: usize = 200;

/// Where a listed record stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RecordState {
    /// MongoDB holds another token at its generation, or another answer of its generation is
    /// kept beside it: left for a refresh, a sign-in or an operator.
    Unmatched,
    /// The next reconciliation settles it (writes it, or removes it).
    Pending,
    /// It cannot be read: it blocks the streamer's refreshes until a sign-in or a discard.
    Unreadable,
    /// In the quarantine: a sign-in superseded it. Never applied.
    Quarantined,
}

/// One recovery record, for an operator. Never holds a token.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct RecoveryRecord {
    /// The streamer's Twitch id.
    pub streamer_id: String,
    /// The key it is in: the record, the side record or the quarantine.
    pub key: RecoveryKey,
    /// For a quarantined record, the key it was moved from.
    pub origin: Option<RecoveryKey>,
    /// Where it stands.
    pub state: RecordState,
    /// The record's generation (MongoDB's generation of the state its exchange started from),
    /// when it can be read.
    pub generation: Option<i64>,
    /// MongoDB's generation now (`None` when the account is gone or for a quarantined record).
    pub stored_generation: Option<i64>,
    /// When it was quarantined (epoch milliseconds), for a quarantined record.
    pub quarantined_at: Option<i64>,
}

/// What an operator decides for a record ([`Twitch::settle_recovery_record`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleAction {
    /// Write the record's answer to MongoDB over whatever it holds (compare-and-set, advancing
    /// the generation), then remove the record. Not for a quarantined record.
    Apply,
    /// Remove the record (or the quarantine key) without writing anything.
    Discard,
}

/// What a settlement did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum SettleOutcome {
    /// The answer was written to MongoDB with this generation, and the record removed.
    Applied {
        /// The generation written.
        generation: i64,
    },
    /// The record was removed.
    Discarded,
    /// There is no such record (settled meanwhile, or never there).
    NotFound,
    /// The account no longer exists; nothing was written (the reconciliation removes the
    /// record).
    AccountGone,
}

fn check_label(what: &'static str, value: &str) -> Result<(), TwitchError> {
    if value.trim().is_empty() || value.chars().count() > MAX_LABEL {
        return Err(TwitchError::Write(format!(
            "the {what} must be 1 to {MAX_LABEL} characters"
        )));
    }
    Ok(())
}

fn parse_millis(value: Option<&String>) -> Option<i64> {
    value.and_then(|text| text.parse().ok())
}

impl Inner {
    /// The records of one streamer, classified the way the reconciliation would (no write).
    async fn list_streamer(
        &self,
        user_id: &str,
        out: &mut Vec<RecoveryRecord>,
    ) -> Result<(), TwitchError> {
        let row = |key, state, generation, stored_generation| RecoveryRecord {
            streamer_id: user_id.to_owned(),
            key,
            origin: None,
            state,
            generation,
            stored_generation,
            quarantined_at: None,
        };
        let mut read: Vec<(RecoveryKey, Record)> = Vec::with_capacity(2);
        let mut unreadable: Vec<RecoveryKey> = Vec::new();
        for slot in [RecoveryKey::Parked, RecoveryKey::Conflict] {
            match self.read_slot(user_id, slot).await {
                Ok(Some(record)) => read.push((slot, record)),
                Ok(None) => {}
                Err(TwitchError::Decode(_) | TwitchError::Cache { .. }) => unreadable.push(slot),
                Err(error) => return Err(error),
            }
        }
        let stored = if read.is_empty() {
            None
        } else {
            self.load_stored(user_id).await?
        };
        let stored_generation = stored.as_ref().map(|stored| stored.generation.millis());
        for slot in unreadable {
            out.push(row(slot, RecordState::Unreadable, None, stored_generation));
        }
        let redundant = matches!(read.as_slice(), [(_, first), (_, second)]
            if self.redundant_side(&first.rotation, &second.rotation));
        let records: Vec<Record> = read.iter().map(|(_, record)| record.clone()).collect();
        let contested = !redundant
            && match &stored {
                Some(stored) => self.contested(stored, &records)?,
                None => false,
            };
        for (index, (slot, record)) in read.iter().enumerate() {
            let state = if contested {
                RecordState::Unmatched
            } else if redundant && index == 1 {
                RecordState::Pending
            } else {
                match &stored {
                    Some(stored) => match self.verdict(stored, &record.rotation) {
                        Ok(Verdict::Unmatched) => RecordState::Unmatched,
                        Ok(_) => RecordState::Pending,
                        Err(_) => RecordState::Unreadable,
                    },
                    None => RecordState::Pending,
                }
            };
            out.push(row(
                *slot,
                state,
                Some(record.rotation.generation),
                stored_generation,
            ));
        }
        Ok(())
    }

    /// The quarantine of one streamer: one row per record moved there.
    async fn list_quarantine(
        &self,
        user_id: &str,
        out: &mut Vec<RecoveryRecord>,
    ) -> Result<(), TwitchError> {
        let fields: HashMap<String, String> = self
            .dragonfly
            .hgetall(&self.config.keys.refresh_quarantine(user_id))
            .await
            .map_err(|error| TwitchError::cache("read quarantine", error))?
            .into_iter()
            .collect();
        let at = parse_millis(fields.get("quarantined_at"));
        for (prefix, origin) in [
            ("parked", RecoveryKey::Parked),
            ("conflict", RecoveryKey::Conflict),
        ] {
            if !fields.contains_key(&format!("{prefix}:type")) {
                continue;
            }
            out.push(RecoveryRecord {
                streamer_id: user_id.to_owned(),
                key: RecoveryKey::Quarantine,
                origin: Some(origin),
                state: RecordState::Quarantined,
                generation: parse_millis(fields.get(&format!("{prefix}:generation"))),
                stored_generation: None,
                quarantined_at: at,
            });
        }
        Ok(())
    }

    /// [`Twitch::recovery_records`].
    async fn recovery_records(&self) -> Result<Vec<RecoveryRecord>, TwitchError> {
        // Streamer id -> (has a record or side record, has a quarantine), in id order.
        let mut found: BTreeMap<String, (bool, bool)> = BTreeMap::new();
        let mut scan = self
            .dragonfly
            .scan(&self.config.keys.recovery_pattern(), Some(500));
        'scan: while let Some(page) = scan
            .next_page()
            .await
            .map_err(|error| TwitchError::cache("scan recovery records", error))?
        {
            for key in page {
                let Some((user_id, kind)) = std::str::from_utf8(&key)
                    .ok()
                    .and_then(|key| self.config.keys.recovery_key(key))
                else {
                    continue;
                };
                if found.len() >= MAX_LISTED_RECORDS && !found.contains_key(user_id) {
                    break 'scan;
                }
                let entry = found.entry(user_id.to_owned()).or_default();
                if kind == RecoveryKey::Quarantine {
                    entry.1 = true;
                } else {
                    entry.0 = true;
                }
            }
        }
        let mut out = Vec::new();
        for (user_id, (records, quarantine)) in found {
            if out.len() >= MAX_LISTED_RECORDS {
                break;
            }
            if records {
                self.list_streamer(&user_id, &mut out).await?;
            }
            if quarantine {
                self.list_quarantine(&user_id, &mut out).await?;
            }
        }
        out.truncate(MAX_LISTED_RECORDS);
        Ok(out)
    }

    /// Writes the answer of `record` over whatever MongoDB holds (compare-and-set on what is
    /// read, advancing the generation), then publishes it and removes the record.
    async fn apply_record(
        &self,
        user_id: &str,
        record: &Record,
    ) -> Result<(SettleOutcome, Option<i64>), TwitchError> {
        let rotation = &record.rotation;
        for _round in 0..CAS_ROUNDS {
            let Some(stored) = self.load_stored(user_id).await? else {
                return Ok((SettleOutcome::AccountGone, None));
            };
            let before = stored.generation.millis();
            if let Written::Done(generation) = self
                .write_rotation(
                    user_id,
                    &stored,
                    &rotation.access,
                    &rotation.refresh,
                    rotation.expires_at,
                )
                .await?
            {
                self.answers.remove_text(user_id, &record.text);
                let fields =
                    rotation_fields(&rotation.access, &rotation.refresh, rotation.expires_at);
                let _ = self.publish(user_id, generation, &fields).await;
                // MongoDB holds it now: a removal that fails leaves a record the next
                // reconciliation finds held and removes.
                let _ = self.unpark(user_id, &record.text).await;
                return Ok((SettleOutcome::Applied { generation }, Some(before)));
            }
        }
        Err(TwitchError::Write(
            "the stored credentials kept changing".to_owned(),
        ))
    }

    /// [`Twitch::settle_recovery_record`], under the streamer's gate and lease.
    async fn settle(
        &self,
        user_id: &str,
        key: RecoveryKey,
        action: SettleAction,
    ) -> Result<(SettleOutcome, Option<i64>, Option<i64>), TwitchError> {
        if key == RecoveryKey::Quarantine {
            return match action {
                SettleAction::Apply => Err(TwitchError::Write(
                    "a quarantined record is never applied".to_owned(),
                )),
                SettleAction::Discard => {
                    let removed = self
                        .dragonfly
                        .del(&[&self.config.keys.refresh_quarantine(user_id)])
                        .await
                        .map_err(|error| TwitchError::cache("discard quarantine", error))?;
                    Ok((
                        if removed > 0 {
                            SettleOutcome::Discarded
                        } else {
                            SettleOutcome::NotFound
                        },
                        None,
                        None,
                    ))
                }
            };
        }
        let record = match self.read_slot(user_id, key).await {
            Ok(Some(record)) => record,
            Ok(None) => return Ok((SettleOutcome::NotFound, None, None)),
            // An unreadable record can only be discarded: removed whatever it holds.
            Err(TwitchError::Decode(_) | TwitchError::Cache { .. })
                if action == SettleAction::Discard =>
            {
                let slot_key = if key == RecoveryKey::Conflict {
                    self.config.keys.parked_conflict(user_id)
                } else {
                    self.config.keys.parked_rotation(user_id)
                };
                let removed = self
                    .dragonfly
                    .del(&[&slot_key])
                    .await
                    .map_err(|error| TwitchError::cache("discard recovery record", error))?;
                return Ok((
                    if removed > 0 {
                        SettleOutcome::Discarded
                    } else {
                        SettleOutcome::NotFound
                    },
                    None,
                    None,
                ));
            }
            Err(error) => return Err(error),
        };
        let generation = Some(record.rotation.generation);
        match action {
            SettleAction::Apply => {
                let (outcome, before) = self.apply_record(user_id, &record).await?;
                Ok((outcome, generation, before))
            }
            SettleAction::Discard => {
                self.answers.remove_text(user_id, &record.text);
                let removed = self.unpark(user_id, &record.text).await?;
                Ok((
                    if removed {
                        SettleOutcome::Discarded
                    } else {
                        SettleOutcome::NotFound
                    },
                    generation,
                    None,
                ))
            }
        }
    }
}

impl Twitch {
    /// Every recovery record and quarantine entry, by streamer id (at most
    /// [`MAX_LISTED_RECORDS`]), each classified the way the reconciliation would see it now
    /// (nothing is written), with its generation and MongoDB's: never a token. For the operator
    /// procedure in `crate::operator`: after the reconciliation leaves `failed` and `left` at
    /// 0, what remains is unmatched, unreadable or quarantined.
    pub async fn recovery_records(&self) -> Result<Vec<RecoveryRecord>, TwitchError> {
        self.inner.recovery_records().await
    }

    /// Settles one named record by an operator's decision: [`SettleAction::Apply`] writes its
    /// answer to MongoDB over whatever MongoDB holds (a compare-and-set that advances the
    /// generation, so the next reconciliation removes what it supersedes), then removes it;
    /// [`SettleAction::Discard`] removes it (an unreadable record or a quarantine key
    /// included). `key` names the record ([`RecoveryKey::Parked`]), the side record
    /// ([`RecoveryKey::Conflict`]) or the quarantine ([`RecoveryKey::Quarantine`], discard
    /// only). `operation_id` and `operator` (1 to 200 characters each) are logged with the
    /// decision at warning level (`token_recovery_settled`). Runs under the streamer's gate and
    /// lease: `Err(TwitchError::Busy)` while another refresh of the streamer holds the lease.
    pub async fn settle_recovery_record(
        &self,
        streamer_id: &str,
        key: RecoveryKey,
        action: SettleAction,
        operation_id: &str,
        operator: &str,
    ) -> Result<SettleOutcome, TwitchError> {
        check_label("operation id", operation_id)?;
        check_label("operator", operator)?;
        let inner = &self.inner;
        let _gate = inner.gate(streamer_id).await?;
        let Some(lease) = inner.try_lease(streamer_id).await? else {
            return Err(TwitchError::Busy);
        };
        let result = inner.settle(streamer_id, key, action).await;
        inner.release(lease).await;
        let (outcome, generation, before) = result?;
        let key_name = match key {
            RecoveryKey::Parked => "parked",
            RecoveryKey::Conflict => "conflict",
            RecoveryKey::Quarantine => "quarantine",
        };
        inner.log(
            Level::Warn,
            Destination::Both,
            Some(streamer_id),
            json!({
                "function": "settleRecoveryRecord",
                "userId": streamer_id,
                "action": "token_recovery_settled",
                "operationId": operation_id,
                "operator": operator,
                "record": key_name,
                "decision": match action {
                    SettleAction::Apply => "apply",
                    SettleAction::Discard => "discard",
                },
                "outcome": match outcome {
                    SettleOutcome::Applied { .. } => "applied",
                    SettleOutcome::Discarded => "discarded",
                    SettleOutcome::NotFound => "not_found",
                    SettleOutcome::AccountGone => "account_gone",
                },
                "recordGeneration": generation,
                "storedGenerationBefore": before,
                "generationWritten": match outcome {
                    SettleOutcome::Applied { generation } => Some(generation),
                    _ => None,
                },
            }),
        );
        Ok(outcome)
    }
}

//! Roulette draw completion over the existing `roulette_channels` collection.
//!
//! This ports only the completion path of `dimabot/src/roulette/service.ts`
//! (`settleDue`/`snapshot`) and `dimabot/src/roulette/model.ts` (`settle`):
//! one bounded poll of indexed `dueAt` deadlines, then a per-channel reload and
//! compare-and-swap on `_id` + `revision` with `$inc revision` that writes only
//! `state` and `dueAt`. Winner AST actions, receipts, overlay tokens, and every
//! unrelated document field are neither executed nor rewritten.
//!
//! `state` is Mixed BSON, so the document is cloned and only the fields the
//! TypeScript code changes are removed or replaced; unknown fields survive at
//! every level. The completed draw is chosen upstream, so no RNG is ported.

use std::{cmp::Ordering, collections::HashSet};

use futures_util::TryStreamExt;
use mongodb::{
    Collection, Database,
    bson::{Bson, Document, doc},
    error::{Error, Result},
};

/// Existing Mongoose collection. No collection, index, or schema is created.
const COLLECTION: &str = "roulette_channels";
/// The TypeScript due query has no sort and caps one pass at 100 channels.
const DUE_LIMIT: i64 = 100;
/// `snapshot` retries the revision CAS this many times before reporting busy.
const CAS_ATTEMPTS: usize = 20;
/// `settle` keeps the newest 100 completed draws.
const HISTORY_LIMIT: usize = 100;
/// `domain.text(channelId, 'channel', 100)` bound.
const CHANNEL_MAX_CHARS: usize = 100;
/// Node promotes int64 to a JavaScript number through the inclusive ±2^53
/// boundary; adjacent int64 values remain Long objects.
const JS_MAX_PROMOTED_INTEGER: f64 = 9_007_199_254_740_992.0;

fn malformed() -> Error {
    Error::custom("Invalid roulette channel state".to_owned())
}

/// Reads a BSON number the way `promoteValues` exposes it to JavaScript.
fn numeric(value: &Bson) -> Option<f64> {
    match value {
        Bson::Int32(value) => Some(f64::from(*value)),
        Bson::Int64(value) => Some(*value as f64),
        Bson::Double(value) => Some(*value),
        _ => None,
    }
}

/// Serializes a JavaScript number as the Node BSON writer does: integral values
/// in the int32 range become `int`, everything else (including `-0` and
/// non-finite values) stays `double`.
fn js_number(value: f64) -> Bson {
    let negative_zero = value == 0.0 && value.is_sign_negative();
    if !negative_zero
        && value.is_finite()
        && value.fract() == 0.0
        && (f64::from(i32::MIN)..=f64::from(i32::MAX)).contains(&value)
    {
        Bson::Int32(value as i32)
    } else {
        Bson::Double(value)
    }
}

/// Normalizes every number the way a TypeScript rewrite of the whole Mixed
/// `state` does. `Long` values outside Node's inclusive ±2^53 promotion
/// boundary stay int64, as JavaScript receives `Long` objects rather than numbers.
fn normalize_js_numbers(value: &mut Bson) {
    match value {
        Bson::Int32(current) => {
            let number = f64::from(*current);
            *value = js_number(number);
        }
        Bson::Int64(current) => {
            let number = *current as f64;
            if number.abs() <= JS_MAX_PROMOTED_INTEGER && number as i64 == *current {
                *value = js_number(number);
            }
        }
        Bson::Double(current) => {
            let number = *current;
            *value = js_number(number);
        }
        Bson::Array(values) => {
            for value in values {
                normalize_js_numbers(value);
            }
        }
        Bson::Document(document) => normalize_document(document),
        _ => {}
    }
}

fn normalize_document(document: &mut Document) {
    for (_, value) in document.iter_mut() {
        normalize_js_numbers(value);
    }
}

fn find_index(documents: &[Bson], id: &str) -> Option<usize> {
    documents.iter().position(|value| {
        value
            .as_document()
            .and_then(|document| document.get("id"))
            .and_then(Bson::as_str)
            == Some(id)
    })
}

fn find_by_id<'a>(documents: &'a [Bson], id: &str) -> Option<&'a Document> {
    find_index(documents, id).and_then(|index| documents[index].as_document())
}

fn find_document_mut<'a>(documents: &'a mut [Bson], id: &str) -> Option<&'a mut Document> {
    for value in documents {
        if let Bson::Document(document) = value
            && document.get("id").and_then(Bson::as_str) == Some(id)
        {
            return Some(document);
        }
    }
    None
}

/// The upstream draw is always present, but malformed nested values must not
/// abort the pass: the TypeScript code reads them as optional lookups too.
struct Completion {
    ends_at: f64,
    roulette_id: Option<String>,
    item_id: Option<String>,
    key: Option<String>,
    action: Option<String>,
    hide_after_seconds: Option<f64>,
}

enum Removal {
    None,
    Item { keys: HashSet<String> },
    Copy { key: String },
}

/// Strict null check: a missing `completedAt` is not a spinning draw, matching
/// `draw.completedAt === null`. A non-numeric `endsAt` never compares due.
fn completion(state: &Document, now_ms: i64) -> Option<Completion> {
    let Some(Bson::Document(draw)) = state.get("draw") else {
        return None;
    };
    if draw.get("completedAt") != Some(&Bson::Null) {
        return None;
    }
    let ends_at = draw.get("endsAt").and_then(numeric)?;
    if !matches!(
        (now_ms as f64).partial_cmp(&ends_at),
        Some(Ordering::Greater | Ordering::Equal)
    ) {
        return None;
    }
    let winner = draw.get("winner").and_then(Bson::as_document);
    Some(Completion {
        ends_at,
        roulette_id: draw
            .get("rouletteId")
            .and_then(Bson::as_str)
            .map(str::to_owned),
        item_id: winner
            .and_then(|winner| winner.get("itemId"))
            .and_then(Bson::as_str)
            .map(str::to_owned),
        key: winner
            .and_then(|winner| winner.get("key"))
            .and_then(Bson::as_str)
            .map(str::to_owned),
        action: draw
            .get("winnerAction")
            .and_then(Bson::as_str)
            .map(str::to_owned),
        // `null` never hides. A corrupt non-numeric value behaves like the
        // TypeScript NaN deadline, which never hides either.
        hide_after_seconds: draw.get("hideAfterSeconds").and_then(numeric),
    })
}

/// Reads the roulette and item once, mirroring the lookups `settle` performs
/// before any mutation. `roulettes` and a matched roulette's `items` are
/// required just as the TypeScript property access requires them.
fn removal_plan(state: &Document, completion: &Completion) -> Result<Removal> {
    let roulettes = match state.get("roulettes") {
        Some(Bson::Array(roulettes)) => roulettes,
        _ => return Err(malformed()),
    };
    let Some(roulette_id) = completion.roulette_id.as_deref() else {
        return Ok(Removal::None);
    };
    let Some(roulette) = find_by_id(roulettes, roulette_id) else {
        return Ok(Removal::None);
    };
    let items = match roulette.get("items") {
        Some(Bson::Array(items)) => items,
        _ => return Err(malformed()),
    };
    let Some(item_id) = completion.item_id.as_deref() else {
        return Ok(Removal::None);
    };
    let Some(item) = find_by_id(items, item_id) else {
        return Ok(Removal::None);
    };
    match completion.action.as_deref() {
        Some("remove-item") => {
            let copies = match item.get("copies") {
                Some(Bson::Array(copies)) => copies,
                _ => return Err(malformed()),
            };
            Ok(Removal::Item {
                keys: copies
                    .iter()
                    .filter_map(Bson::as_str)
                    .map(str::to_owned)
                    .collect(),
            })
        }
        Some("remove-copy") => {
            let copies = match item.get("copies") {
                Some(Bson::Array(copies)) => copies,
                _ => return Err(malformed()),
            };
            let Some(key) = completion.key.as_deref() else {
                return Ok(Removal::None);
            };
            if copies.iter().any(|copy| copy.as_str() == Some(key)) {
                Ok(Removal::Copy {
                    key: key.to_owned(),
                })
            } else {
                // A copy deleted after the draw started is left alone.
                Ok(Removal::None)
            }
        }
        _ => Ok(Removal::None),
    }
}

fn apply_removal(state: &mut Document, completion: &Completion, removal: Removal) -> Result<()> {
    let roulette_id = completion.roulette_id.as_deref().ok_or_else(malformed)?;
    let item_id = completion.item_id.as_deref().ok_or_else(malformed)?;
    let roulettes = match state.get_mut("roulettes") {
        Some(Bson::Array(roulettes)) => roulettes,
        _ => return Err(malformed()),
    };
    let Some(roulette) = find_document_mut(roulettes, roulette_id) else {
        return Ok(());
    };
    match removal {
        Removal::None => Ok(()),
        Removal::Item { keys } => {
            let order = match roulette.get_mut("order") {
                Some(Bson::Array(order)) => order,
                _ => return Err(malformed()),
            };
            order.retain(|value| !value.as_str().is_some_and(|key| keys.contains(key)));
            let items = match roulette.get_mut("items") {
                Some(Bson::Array(items)) => items,
                _ => return Err(malformed()),
            };
            items.retain(|value| {
                value
                    .as_document()
                    .and_then(|item| item.get("id"))
                    .and_then(Bson::as_str)
                    != Some(item_id)
            });
            Ok(())
        }
        Removal::Copy { key } => {
            let remaining = {
                let items = match roulette.get_mut("items") {
                    Some(Bson::Array(items)) => items,
                    _ => return Err(malformed()),
                };
                let index = find_index(items, item_id).ok_or_else(malformed)?;
                let item = match &mut items[index] {
                    Bson::Document(item) => item,
                    _ => return Err(malformed()),
                };
                let copies = match item.get_mut("copies") {
                    Some(Bson::Array(copies)) => copies,
                    _ => return Err(malformed()),
                };
                copies.retain(|value| value.as_str() != Some(key.as_str()));
                let remaining = copies.len();
                // `item.multiplier = item.copies.length`
                item.insert("multiplier", js_number(remaining as f64));
                remaining
            };
            let order = match roulette.get_mut("order") {
                Some(Bson::Array(order)) => order,
                _ => return Err(malformed()),
            };
            order.retain(|value| value.as_str() != Some(key.as_str()));
            if remaining == 0 {
                // `if (!item.multiplier) r.items = ...filter(...)`
                let items = match roulette.get_mut("items") {
                    Some(Bson::Array(items)) => items,
                    _ => return Err(malformed()),
                };
                items.retain(|value| {
                    value
                        .as_document()
                        .and_then(|item| item.get("id"))
                        .and_then(Bson::as_str)
                        != Some(item_id)
                });
            }
            Ok(())
        }
    }
}

/// `settle`: completion and winner removal belong to the same CAS write.
fn apply_completion(state: &mut Document, completion: Completion) -> Result<()> {
    let removal = removal_plan(state, &completion)?;
    match removal {
        Removal::None => {}
        removal => apply_removal(state, &completion, removal)?,
    }
    let draw = match state.get_mut("draw") {
        Some(Bson::Document(draw)) => draw,
        _ => return Err(malformed()),
    };
    draw.insert("completedAt", js_number(completion.ends_at));
    // History keeps the completed draw without its `slots` field and in the
    // same key order as the persisted draw.
    let mut entry = draw.clone();
    entry.remove("slots");
    let hide_at = completion.hide_after_seconds.map_or(Bson::Null, |seconds| {
        js_number(completion.ends_at + seconds * 1000.0)
    });
    let history = match state.get_mut("history") {
        Some(Bson::Array(history)) => history,
        _ => return Err(malformed()),
    };
    history.insert(0, Bson::Document(entry));
    history.truncate(HISTORY_LIMIT);
    state.insert("hideAt", hide_at);
    Ok(())
}

/// Pure completion port of `model.ts` `settle`. Returns whether the state
/// changed, so a CAS write only happens for a real transition.
pub fn settle(state: &mut Document, now_ms: i64) -> Result<bool> {
    let mut changed = false;
    if let Some(completion) = completion(state, now_ms) {
        apply_completion(state, completion)?;
        changed = true;
    }
    // Re-checked after completion, so a long outage can finish and hide in one
    // write exactly as the TypeScript settle does.
    if let Some(hide_at) = state.get("hideAt").and_then(numeric)
        && now_ms as f64 >= hide_at
    {
        state.insert("visible", Bson::Boolean(false));
        state.insert("hideAt", Bson::Null);
        changed = true;
    }
    Ok(changed)
}

/// `due(state)`: a spinning draw is due at `endsAt`, otherwise at `hideAt`.
fn due_at(state: &Document) -> Bson {
    if let Some(Bson::Document(draw)) = state.get("draw")
        && draw.get("completedAt") == Some(&Bson::Null)
        && let Some(ends_at) = draw.get("endsAt").and_then(numeric)
    {
        return js_number(ends_at);
    }
    state
        .get("hideAt")
        .and_then(numeric)
        .map_or(Bson::Null, js_number)
}

/// `domain.text(value, 'channel', 100)`: the due row must carry a usable string
/// id. TypeScript validates the trimmed UTF-16 length but discards the return
/// value, so the raw id remains the lookup key.
fn channel_id(row: &Document) -> Result<String> {
    let Some(value) = row.get("_id").and_then(Bson::as_str) else {
        return Err(malformed());
    };
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.encode_utf16().count() > CHANNEL_MAX_CHARS {
        return Err(malformed());
    }
    Ok(value.to_owned())
}

/// Fields `RouletteChannel.create` supplies when `load` finds no document.
/// Schema defaults add `actions` and `actionDueAt`; `overlayToken` has none.
fn default_document() -> Document {
    doc! {
        "actions": Bson::Array(Vec::new()),
        "actionDueAt": Bson::Null,
        "revision": 0i32,
        "state": Bson::Document(doc! {
            "roulettes": Bson::Array(Vec::new()),
            "activeId": Bson::Null,
            "visible": false,
            "draw": Bson::Null,
            "history": Bson::Array(Vec::new()),
            "hideAt": Bson::Null,
        }),
        "tokenHash": Bson::Null,
        "dueAt": Bson::Null,
        "receipts": Bson::Array(Vec::new()),
    }
}

/// Native completion worker. Construction performs no I/O and selects only the
/// existing collection.
#[derive(Clone)]
pub struct RouletteCompletion {
    channels: Collection<Document>,
}

impl RouletteCompletion {
    pub fn new(database: Database) -> Self {
        Self {
            channels: database.collection(COLLECTION),
        }
    }

    /// One bounded pass. Counts only channels this pass successfully changes;
    /// concurrent no-ops do not count as completed work.
    pub async fn settle_due(&self) -> Result<usize> {
        let now_ms = mongodb::bson::DateTime::now().timestamp_millis();
        // `$ne: null` excludes missing deadlines. No sort is added, matching
        // the TypeScript query and its existing `dueAt` index.
        let due = doc! {
            "dueAt": {
                "$ne": Bson::Null,
                "$lte": js_number(now_ms as f64),
            },
        };
        let rows: Vec<Document> = self
            .channels
            .find(due)
            .projection(doc! { "_id": 1 })
            .limit(DUE_LIMIT)
            .await?
            .try_collect()
            .await?;
        let mut processed = 0usize;
        for row in rows {
            let channel = channel_id(&row)?;
            if self.settle_channel(&channel).await? {
                processed += 1;
            }
        }
        Ok(processed)
    }

    /// `snapshot`: reload, settle, and CAS until one write wins or the bounded
    /// retry count is exhausted.
    async fn settle_channel(&self, channel: &str) -> Result<bool> {
        for _ in 0..CAS_ATTEMPTS {
            let stored = self.load(channel).await?;
            let revision = match stored.get("revision") {
                Some(value) if numeric(value).is_some() => value.clone(),
                _ => return Err(malformed()),
            };
            let Some(Bson::Document(mut state)) = stored.get("state").cloned() else {
                return Err(malformed());
            };
            // Like TypeScript snapshot, refresh wall time after every reload,
            // including a retry after another writer wins the revision CAS.
            let now_ms = mongodb::bson::DateTime::now().timestamp_millis();
            if !settle(&mut state, now_ms)? {
                return Ok(false);
            }
            // The TypeScript write re-serializes the whole Mixed state through
            // the JavaScript BSON rules; normalize numbers the same way.
            normalize_document(&mut state);
            let due = due_at(&state);
            let update = doc! {
                "$set": {
                    "state": Bson::Document(state),
                    "dueAt": due,
                },
                "$inc": { "revision": 1i32 },
            };
            let saved = self
                .channels
                .update_one(doc! { "_id": channel, "revision": revision }, update)
                .await?;
            if saved.modified_count > 0 {
                return Ok(true);
            }
        }
        Err(Error::custom("Roulette channel is busy".to_owned()))
    }

    /// `load`: a missing channel is created with the default state and read
    /// again. The upsert keeps that idempotent when another process creates the
    /// same default document concurrently.
    async fn load(&self, channel: &str) -> Result<Document> {
        if let Some(document) = self.channels.find_one(doc! { "_id": channel }).await? {
            return Ok(document);
        }
        // A failed create is reported by the read below; the caller only needs
        // a usable document or a generic error.
        let _ = self
            .channels
            .update_one(
                doc! { "_id": channel },
                doc! { "$setOnInsert": default_document() },
            )
            .upsert(true)
            .await;
        self.channels
            .find_one(doc! { "_id": channel })
            .await?
            .ok_or_else(|| Error::custom("Roulette channel default creation failed".to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENDS: i64 = 1_700_000_000_000;

    fn fixture_state(action: &str, copies: usize) -> Document {
        let winner_keys: Vec<Bson> = (0..copies)
            .map(|index| Bson::String(format!("c{index}")))
            .collect();
        let mut order = winner_keys.clone();
        order.push(Bson::String("o1".to_owned()));
        order.push(Bson::String("o2".to_owned()));
        doc! {
            "roulettes": Bson::Array(vec![Bson::Document(doc! {
                "id": "r1",
                "alias": "fixture",
                "name": "Fixture",
                "design": "wheel",
                "cardSize": "large",
                "colors": Bson::Array(vec![Bson::String("#cbbaff".to_owned())]),
                "durationSeconds": 4i32,
                "settings": Bson::Document(doc! {
                    "insertion": "append",
                    "duplicate": "separate",
                    "shuffleBeforeDraw": false,
                    "showOnStart": true,
                    "hideAfterSeconds": Bson::Null,
                    "winnerAction": action,
                }),
                "items": Bson::Array(vec![
                    Bson::Document(doc! {
                        "id": "i1",
                        "label": "Frozen winner",
                        "multiplier": copies as i32,
                        "weight": 7i32,
                        "copies": Bson::Array(winner_keys),
                        "action": "$(never_execute_roulette_fixture)",
                    }),
                    Bson::Document(doc! {
                        "id": "i2",
                        "label": "Other",
                        "multiplier": 2i32,
                        "weight": 1i32,
                        "copies": Bson::Array(vec![
                            Bson::String("o1".to_owned()),
                            Bson::String("o2".to_owned()),
                        ]),
                    }),
                ]),
                "order": Bson::Array(order),
            })]),
            "activeId": "r1",
            "visible": true,
            "draw": Bson::Document(doc! {
                "id": "d1",
                "rouletteId": "r1",
                "startedAt": Bson::Double(ENDS as f64),
                "endsAt": Bson::Double(ENDS as f64),
                "completedAt": Bson::Null,
                "winner": Bson::Document(doc! {
                    "key": "c0",
                    "itemId": "i1",
                    "label": "Frozen winner",
                    "weight": 7i32,
                    "copy": 1i32,
                    "multiplier": copies as i32,
                }),
                "slots": Bson::Array(vec![Bson::Document(doc! {
                    "key": "c0",
                    "itemId": "i1",
                })]),
                "design": "wheel",
                "cardSize": "large",
                "colors": Bson::Array(vec![Bson::String("#cbbaff".to_owned())]),
                "winnerAction": action,
                "hideAfterSeconds": Bson::Null,
            }),
            "history": Bson::Array(Vec::new()),
            "hideAt": Bson::Null,
        }
    }

    fn draw(state: &Document) -> &Document {
        state.get_document("draw").unwrap()
    }

    fn draw_mut(state: &mut Document) -> &mut Document {
        state.get_document_mut("draw").unwrap()
    }

    fn roulette(state: &Document) -> &Document {
        state
            .get_array("roulettes")
            .unwrap()
            .first()
            .and_then(Bson::as_document)
            .unwrap()
    }

    fn roulette_mut(state: &mut Document) -> &mut Document {
        match state.get_mut("roulettes").unwrap() {
            Bson::Array(roulettes) => match &mut roulettes[0] {
                Bson::Document(roulette) => roulette,
                other => panic!("unexpected roulette {other:?}"),
            },
            other => panic!("unexpected roulettes {other:?}"),
        }
    }

    fn items(state: &Document) -> &Vec<Bson> {
        roulette(state).get_array("items").unwrap()
    }

    fn item<'a>(state: &'a Document, id: &str) -> &'a Document {
        find_by_id(items(state), id).unwrap()
    }

    fn order(state: &Document) -> &Vec<Bson> {
        roulette(state).get_array("order").unwrap()
    }

    #[test]
    fn completion_records_history_without_slots_and_keeps_the_winner() {
        let mut state = fixture_state("keep", 2);
        state.insert("future", Bson::Document(doc! { "keep": true }));
        let before = state.clone();
        assert!(settle(&mut state, ENDS + 1).unwrap());
        assert_eq!(
            draw(&state).get("completedAt"),
            Some(&Bson::Double(ENDS as f64))
        );
        // The persisted draw keeps its winner and slot list.
        assert_eq!(
            draw(&state)
                .get_document("winner")
                .unwrap()
                .get_str("key")
                .unwrap(),
            "c0"
        );
        assert!(draw(&state).get_array("slots").is_ok());
        let history = state.get_array("history").unwrap();
        assert_eq!(history.len(), 1);
        let entry = history[0].as_document().unwrap();
        assert!(entry.get("slots").is_none());
        assert_eq!(
            entry.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "id",
                "rouletteId",
                "startedAt",
                "endsAt",
                "completedAt",
                "winner",
                "design",
                "cardSize",
                "colors",
                "winnerAction",
                "hideAfterSeconds",
            ]
        );
        // `keep` leaves the roulette, its items, and the order untouched.
        assert_eq!(roulette(&state), roulette(&before));
        // An unrelated Mixed field survives the rewrite.
        assert!(
            state
                .get_document("future")
                .unwrap()
                .get_bool("keep")
                .unwrap()
        );
        assert_eq!(due_at(&state), Bson::Null);
    }

    #[test]
    fn spinning_draw_with_a_future_deadline_is_untouched() {
        let mut state = fixture_state("remove-copy", 2);
        let before = state.clone();
        assert!(!settle(&mut state, ENDS - 1).unwrap());
        assert_eq!(state, before);
        assert_eq!(due_at(&state), Bson::Double(ENDS as f64));
    }

    #[test]
    fn nan_deadline_never_completes_a_draw() {
        let mut state = fixture_state("remove-copy", 2);
        draw_mut(&mut state).insert("endsAt", Bson::Double(f64::NAN));
        let roulette_before = roulette(&state).clone();
        assert!(!settle(&mut state, ENDS + 60_000).unwrap());
        assert_eq!(draw(&state).get("completedAt"), Some(&Bson::Null));
        assert_eq!(roulette(&state), &roulette_before);
        assert!(state.get_array("history").unwrap().is_empty());
        assert!(matches!(draw(&state).get("endsAt"), Some(Bson::Double(value)) if value.is_nan()));
    }

    #[test]
    fn completed_or_non_null_draws_never_complete_twice() {
        let mut completed = fixture_state("keep", 2);
        draw_mut(&mut completed).insert("completedAt", Bson::Double(ENDS as f64));
        let before = completed.clone();
        assert!(!settle(&mut completed, ENDS + 60_000).unwrap());
        assert_eq!(completed, before);

        // A missing `completedAt` is not the strict `null` the TypeScript code
        // checks for, so the draw is not completed.
        let mut missing = fixture_state("keep", 2);
        draw_mut(&mut missing).remove("completedAt");
        let before = missing.clone();
        assert!(!settle(&mut missing, ENDS + 60_000).unwrap());
        assert_eq!(missing, before);
    }

    #[test]
    fn hide_deadline_comes_from_the_frozen_draw_and_hides_when_due() {
        let mut state = fixture_state("keep", 2);
        draw_mut(&mut state).insert("hideAfterSeconds", 5i32);
        assert!(settle(&mut state, ENDS + 1).unwrap());
        let hide_at = Bson::Double((ENDS + 5_000) as f64);
        assert_eq!(state.get("hideAt"), Some(&hide_at));
        assert_eq!(due_at(&state), hide_at);
        assert_eq!(state.get("visible"), Some(&Bson::Boolean(true)));
        assert!(settle(&mut state, ENDS + 5_000).unwrap());
        assert_eq!(state.get("visible"), Some(&Bson::Boolean(false)));
        assert_eq!(state.get("hideAt"), Some(&Bson::Null));
        assert_eq!(due_at(&state), Bson::Null);
    }

    #[test]
    fn a_long_outage_completes_and_hides_in_one_settle() {
        let mut state = fixture_state("keep", 2);
        draw_mut(&mut state).insert("hideAfterSeconds", 1i32);
        assert!(settle(&mut state, ENDS + 60_000).unwrap());
        assert_eq!(state.get("visible"), Some(&Bson::Boolean(false)));
        assert_eq!(state.get("hideAt"), Some(&Bson::Null));
        assert_eq!(state.get_array("history").unwrap().len(), 1);
        assert_eq!(due_at(&state), Bson::Null);
    }

    #[test]
    fn zero_hide_delay_hides_immediately() {
        let mut state = fixture_state("keep", 2);
        draw_mut(&mut state).insert("hideAfterSeconds", 0i32);
        assert!(settle(&mut state, ENDS + 1).unwrap());
        assert_eq!(state.get("visible"), Some(&Bson::Boolean(false)));
        assert_eq!(state.get("hideAt"), Some(&Bson::Null));
        assert_eq!(due_at(&state), Bson::Null);
    }

    #[test]
    fn hide_only_tick_uses_the_existing_deadline() {
        let mut state = fixture_state("keep", 2);
        draw_mut(&mut state).insert("completedAt", Bson::Double(ENDS as f64));
        state.insert("hideAt", Bson::Double((ENDS - 1_000) as f64));
        state.insert("visible", Bson::Boolean(true));
        assert!(settle(&mut state, ENDS + 1).unwrap());
        assert_eq!(state.get("visible"), Some(&Bson::Boolean(false)));
        assert_eq!(state.get("hideAt"), Some(&Bson::Null));
        assert_eq!(due_at(&state), Bson::Null);
    }

    #[test]
    fn remove_item_drops_the_item_and_all_of_its_order_copies() {
        let mut state = fixture_state("remove-item", 2);
        assert!(settle(&mut state, ENDS + 1).unwrap());
        assert_eq!(items(&state).len(), 1);
        assert_eq!(item(&state, "i2").get_str("id").unwrap(), "i2");
        assert_eq!(
            order(&state),
            &vec![Bson::String("o1".to_owned()), Bson::String("o2".to_owned())]
        );
        assert_eq!(state.get_array("history").unwrap().len(), 1);
    }

    #[test]
    fn remove_copy_removes_only_the_winner_copy() {
        let mut state = fixture_state("remove-copy", 3);
        assert!(settle(&mut state, ENDS + 1).unwrap());
        let winner = item(&state, "i1");
        assert_eq!(
            winner.get_array("copies").unwrap(),
            &vec![Bson::String("c1".to_owned()), Bson::String("c2".to_owned()),]
        );
        assert_eq!(winner.get_i32("multiplier").unwrap(), 2);
        assert_eq!(
            order(&state),
            &vec![
                Bson::String("c1".to_owned()),
                Bson::String("c2".to_owned()),
                Bson::String("o1".to_owned()),
                Bson::String("o2".to_owned()),
            ]
        );
    }

    #[test]
    fn removing_the_last_copy_drops_the_item() {
        let mut state = fixture_state("remove-copy", 1);
        assert!(settle(&mut state, ENDS + 1).unwrap());
        assert_eq!(items(&state).len(), 1);
        assert_eq!(item(&state, "i2").get_str("id").unwrap(), "i2");
        assert_eq!(
            order(&state),
            &vec![Bson::String("o1".to_owned()), Bson::String("o2".to_owned())]
        );
    }

    #[test]
    fn winner_copy_removed_after_the_draw_started_is_left_alone() {
        let mut state = fixture_state("remove-copy", 2);
        {
            let item = roulette_mut(&mut state);
            let items = match item.get_mut("items").unwrap() {
                Bson::Array(items) => items,
                other => panic!("unexpected items {other:?}"),
            };
            let winner = match &mut items[0] {
                Bson::Document(winner) => winner,
                other => panic!("unexpected item {other:?}"),
            };
            match winner.get_mut("copies").unwrap() {
                Bson::Array(copies) => copies.retain(|copy| copy.as_str() != Some("c0")),
                other => panic!("unexpected copies {other:?}"),
            }
            winner.insert("multiplier", 1i32);
            match item.get_mut("order").unwrap() {
                Bson::Array(order) => order.retain(|copy| copy.as_str() != Some("c0")),
                other => panic!("unexpected order {other:?}"),
            }
        }
        let before = roulette(&state).clone();
        assert!(settle(&mut state, ENDS + 1).unwrap());
        // Completion is still recorded, but no second copy is removed.
        assert_eq!(roulette(&state), &before);
        assert_eq!(state.get_array("history").unwrap().len(), 1);
    }

    #[test]
    fn deleted_item_and_deleted_roulette_still_complete() {
        let mut deleted_item = fixture_state("remove-item", 2);
        {
            let roulette = roulette_mut(&mut deleted_item);
            let items = match roulette.get_mut("items").unwrap() {
                Bson::Array(items) => items,
                other => panic!("unexpected items {other:?}"),
            };
            items.retain(|value| {
                value
                    .as_document()
                    .and_then(|item| item.get("id"))
                    .and_then(Bson::as_str)
                    != Some("i1")
            });
        }
        assert!(settle(&mut deleted_item, ENDS + 1).unwrap());
        assert_eq!(items(&deleted_item).len(), 1);
        assert_eq!(deleted_item.get_array("history").unwrap().len(), 1);

        let mut deleted_roulette = fixture_state("remove-copy", 2);
        deleted_roulette.insert("roulettes", Bson::Array(Vec::new()));
        assert!(settle(&mut deleted_roulette, ENDS + 1).unwrap());
        assert_eq!(
            draw(&deleted_roulette)
                .get("completedAt")
                .unwrap()
                .as_f64()
                .unwrap(),
            ENDS as f64
        );
        assert_eq!(deleted_roulette.get_array("history").unwrap().len(), 1);
    }

    #[test]
    fn history_keeps_the_newest_hundred_entries() {
        let mut state = fixture_state("keep", 2);
        let entries: Vec<Bson> = (0..100)
            .map(|index| Bson::Document(doc! { "id": format!("old-{index}") }))
            .collect();
        state.insert("history", Bson::Array(entries));
        assert!(settle(&mut state, ENDS + 1).unwrap());
        let history = state.get_array("history").unwrap();
        assert_eq!(history.len(), 100);
        assert_eq!(
            history[0].as_document().unwrap().get_str("id").unwrap(),
            "d1"
        );
        assert_eq!(
            history[99].as_document().unwrap().get_str("id").unwrap(),
            "old-98"
        );
    }

    #[test]
    fn numbers_follow_javascript_bson_serialization() {
        let mut document = doc! {
            "int32": 7i32,
            "doubleInRange": Bson::Double(4.0),
            "doubleTime": Bson::Double(ENDS as f64),
            "int64InRange": 9i64,
            "int64Time": ENDS,
            "int64Unsafe": 9_007_199_254_740_993i64,
            "fraction": Bson::Double(1.5),
            "nan": Bson::Double(f64::NAN),
            "negativeZero": Bson::Double(-0.0),
            "nested": Bson::Document(doc! { "value": 3i64 }),
            "list": Bson::Array(vec![Bson::Double(2.0)]),
            "date": Bson::DateTime(mongodb::bson::DateTime::from_millis(123)),
            "decimal": Bson::Decimal128("123.450".parse().unwrap()),
        };
        normalize_document(&mut document);
        assert_eq!(document.get("int32"), Some(&Bson::Int32(7)));
        assert_eq!(document.get("doubleInRange"), Some(&Bson::Int32(4)));
        assert_eq!(document.get("doubleTime"), Some(&Bson::Double(ENDS as f64)));
        assert_eq!(document.get("int64InRange"), Some(&Bson::Int32(9)));
        assert_eq!(document.get("int64Time"), Some(&Bson::Double(ENDS as f64)));
        assert_eq!(
            document.get("int64Unsafe"),
            Some(&Bson::Int64(9_007_199_254_740_993))
        );
        assert_eq!(document.get("fraction"), Some(&Bson::Double(1.5)));
        assert_eq!(
            document.get_document("nested").unwrap().get("value"),
            Some(&Bson::Int32(3))
        );
        assert_eq!(document.get_array("list").unwrap()[0], Bson::Int32(2));
        assert!(matches!(document.get("nan"), Some(Bson::Double(value)) if value.is_nan()));
        assert!(
            matches!(document.get("negativeZero"), Some(Bson::Double(value)) if *value == 0.0 && value.is_sign_negative())
        );
        assert!(matches!(document.get("date"), Some(Bson::DateTime(_))));
        assert!(matches!(document.get("decimal"), Some(Bson::Decimal128(_))));
    }

    #[test]
    fn int64_promotion_includes_both_two_to_the_53_boundaries() {
        let mut document = doc! {
            "positiveBoundary": 9_007_199_254_740_992i64,
            "negativeBoundary": -9_007_199_254_740_992i64,
            "positiveAdjacent": 9_007_199_254_740_993i64,
            "negativeAdjacent": -9_007_199_254_740_993i64,
        };
        normalize_document(&mut document);
        assert_eq!(
            document.get("positiveBoundary"),
            Some(&Bson::Double(9_007_199_254_740_992.0))
        );
        assert_eq!(
            document.get("negativeBoundary"),
            Some(&Bson::Double(-9_007_199_254_740_992.0))
        );
        assert_eq!(
            document.get("positiveAdjacent"),
            Some(&Bson::Int64(9_007_199_254_740_993))
        );
        assert_eq!(
            document.get("negativeAdjacent"),
            Some(&Bson::Int64(-9_007_199_254_740_993))
        );
    }

    #[test]
    fn due_at_requires_the_strict_null_completion() {
        let mut spinning = fixture_state("keep", 2);
        assert_eq!(due_at(&spinning), Bson::Double(ENDS as f64));
        draw_mut(&mut spinning).remove("completedAt");
        assert_eq!(due_at(&spinning), Bson::Null);

        let mut hidden = fixture_state("keep", 2);
        draw_mut(&mut hidden).insert("completedAt", Bson::Double(ENDS as f64));
        assert_eq!(due_at(&hidden), Bson::Null);
        hidden.insert("hideAt", Bson::Double((ENDS + 1_000) as f64));
        assert_eq!(due_at(&hidden), Bson::Double((ENDS + 1_000) as f64));
    }

    #[test]
    fn channel_ids_must_be_bounded_strings() {
        assert_eq!(
            channel_id(&doc! { "_id": " 533538623 " }).unwrap(),
            " 533538623 "
        );
        let unicode_boundary = "😀".repeat(CHANNEL_MAX_CHARS / 2);
        assert_eq!(
            channel_id(&doc! { "_id": unicode_boundary.clone() }).unwrap(),
            unicode_boundary
        );
        for row in [
            doc! {},
            doc! { "_id": 12i32 },
            doc! { "_id": "   " },
            doc! { "_id": "x".repeat(CHANNEL_MAX_CHARS + 1) },
            doc! { "_id": "😀".repeat(CHANNEL_MAX_CHARS / 2 + 1) },
        ] {
            assert!(channel_id(&row).is_err());
        }
    }

    #[test]
    fn default_document_matches_the_typescript_empty_state() {
        let document = default_document();
        assert_eq!(document.get_i32("revision").unwrap(), 0);
        assert_eq!(document.get("tokenHash"), Some(&Bson::Null));
        assert_eq!(document.get("dueAt"), Some(&Bson::Null));
        assert_eq!(document.get_array("actions").unwrap().len(), 0);
        assert_eq!(document.get("actionDueAt"), Some(&Bson::Null));
        assert_eq!(document.get_array("receipts").unwrap().len(), 0);
        assert!(document.get("overlayToken").is_none());
        let state = document.get_document("state").unwrap();
        assert_eq!(
            state.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "roulettes",
                "activeId",
                "visible",
                "draw",
                "history",
                "hideAt",
            ]
        );
        assert_eq!(state.get("visible"), Some(&Bson::Boolean(false)));
        assert_eq!(state.get("hideAt"), Some(&Bson::Null));
    }
}

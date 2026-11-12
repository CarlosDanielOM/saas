//! A read type decodes everything the write helpers of its collection accept (`MIGRATION.md`
//! section 8), for every registered collection.
//!
//! For each collection the test builds a base document (the recorded `create` and `journal`
//! cases of the collection, merged), then, for every schema path (array element `0`, Map key
//! `k`, and a key below `Mixed` and Map values included) and every probe value (`null`, each
//! scalar type, empty and filled objects and arrays), it tries each write the helpers offer:
//! create, `$set`, `$unset`, `$push`, upsert, and save `set`/`unset` (through the module's
//! adapter for a collection with hooks). Every write a helper prepares is run against a throwaway
//! database and every document left there is decoded with the read type. A refused write (a
//! validation error, the write guard, a cast error) is fine; a written document that does not
//! decode is a failure naming the collection, the write, the path and the value.
//!
//! Dotted writes get a filter that proves the objects on their way exist (the write guard asks
//! for one, `src/shape.rs`); when the base document lacks them, the write matches nothing.

mod support;

use anyhow::{Context, Result, bail};
use bson::oid::ObjectId;
use bson::{Bson, Document, RawDocumentBuf, doc};
use dima_model::availability::Writer;
use dima_model::{CollectionInfo, REGISTRY};
use dima_store::mongo::schema::{Field, Kind, MapOf, Schema};
use dima_store::mongo::update::UpdateOptions;
use dima_store::mongo::{MongoStore, WriteContext};
use futures_util::TryStreamExt;
use serde_json::Value;
use std::collections::BTreeMap;

const NOW_MS: i64 = 1_794_392_430_456;

fn probes() -> Vec<Bson> {
    let id = ObjectId::from_bytes([7; 12]);
    vec![
        Bson::Null,
        Bson::String("x 👋🏽".into()),
        Bson::String(String::new()),
        Bson::Int32(7),
        Bson::Double(1.5),
        Bson::Boolean(true),
        Bson::DateTime(bson::DateTime::from_millis(NOW_MS)),
        Bson::ObjectId(id),
        Bson::Document(doc! {}),
        Bson::Document(doc! { "k": "v" }),
        Bson::Array(Vec::new()),
        Bson::Array(vec![Bson::String("x".into())]),
        Bson::Array(vec![Bson::Document(doc! { "k": "v" })]),
        Bson::Array(vec![Bson::Null]),
    ]
}

/// Every path of the schema to probe, parents before children.
fn paths(schema: &Schema) -> Vec<String> {
    fn walk(fields: &[Field], prefix: &str, out: &mut Vec<String>) {
        for field in fields {
            let path = format!("{prefix}{}", field.name);
            out.push(path.clone());
            match field.kind {
                Kind::Value(_) => {}
                Kind::Mixed => out.push(format!("{path}.x")),
                Kind::Nested(children) => walk(children, &format!("{path}."), out),
                Kind::Subdocument(schema) => walk(schema.fields, &format!("{path}."), out),
                Kind::DocumentArray(schema) => {
                    out.push(format!("{path}.0"));
                    walk(schema.fields, &format!("{path}.0."), out);
                }
                Kind::Array(_) | Kind::MixedArray => out.push(format!("{path}.0")),
                Kind::Map(MapOf::Values(_) | MapOf::Mixed) => {
                    out.push(format!("{path}.k"));
                    out.push(format!("{path}.k.x"));
                }
                Kind::Map(MapOf::Subdocuments(schema)) => {
                    out.push(format!("{path}.k"));
                    walk(schema.fields, &format!("{path}.k."), out);
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(schema.fields, "", &mut out);
    if let Some(timestamps) = schema.timestamps {
        out.extend(timestamps.updated_at.map(str::to_owned));
    }
    out.extend(schema.version_key.map(str::to_owned));
    out
}

/// `$set` of a dotted path into a document, following array positions; `false` when an
/// element on the way does not exist.
fn put(document: &mut Document, path: &str, value: Bson) -> bool {
    let Some((head, rest)) = path.split_once('.') else {
        document.insert(path, value);
        return true;
    };
    if !matches!(document.get(head), Some(Bson::Document(_) | Bson::Array(_))) {
        document.insert(head, doc! {});
    }
    match document.get_mut(head) {
        Some(Bson::Document(inner)) => put(inner, rest, value),
        Some(Bson::Array(items)) => {
            let (index, deeper) = match rest.split_once('.') {
                Some((index, deeper)) => (index, Some(deeper)),
                None => (rest, None),
            };
            let Some(slot) = index.parse::<usize>().ok().and_then(|i| items.get_mut(i)) else {
                return false;
            };
            match (deeper, slot) {
                (None, slot) => {
                    *slot = value;
                    true
                }
                (Some(deeper), Bson::Document(inner)) => put(inner, deeper, value),
                _ => false,
            }
        }
        _ => false,
    }
}

/// The recorded create cases of `collection`, merged (the first value of a key wins).
fn base_given(cases: &[Value], collection: &str) -> Result<Document> {
    let mut base = Document::new();
    for case in cases {
        let op = case.get("op").and_then(Value::as_str);
        if case.get("collection").and_then(Value::as_str) != Some(collection)
            || !matches!(op, Some("create" | "journal"))
            || case.get("error").is_some()
        {
            continue;
        }
        let doc = case.pointer("/intent/doc").context("doc")?;
        let Bson::Document(doc) = Bson::try_from(doc.clone())? else {
            bail!("{collection}: a create case without a document");
        };
        for (key, value) in doc {
            if !base.contains_key(&key) {
                base.insert(key, value);
            }
        }
    }
    Ok(base)
}

/// Every document of the collection decoded with the read type; the failures.
async fn decode_all(store: &MongoStore, info: &CollectionInfo) -> Result<Vec<String>> {
    let documents: Vec<RawDocumentBuf> = store
        .database()
        .collection::<RawDocumentBuf>(info.name)
        .find(doc! {})
        .await?
        .try_collect()
        .await?;
    Ok(documents
        .iter()
        .filter_map(|raw| (info.decode)(raw).err().map(|e| e.to_string()))
        .collect())
}

/// One probe's outcome counters.
#[derive(Default)]
struct Counts {
    written: u64,
    refused: u64,
}

struct Probe<'a> {
    store: &'a MongoStore,
    info: &'static CollectionInfo,
    base: Document,
    base_id: Bson,
    failures: Vec<String>,
    counts: Counts,
}

impl Probe<'_> {
    /// Back to the base document alone.
    async fn reset(&self) -> Result<()> {
        let collection = self.store.documents(self.info.name);
        collection.delete_many(doc! {}).await?;
        collection.insert_one(self.base.clone()).await?;
        Ok(())
    }

    async fn check(&mut self, what: &str, path: &str, value: &Bson) -> Result<()> {
        self.counts.written += 1;
        for error in decode_all(self.store, self.info).await? {
            self.failures.push(format!(
                "{}: {what} {path} = {value}: {error}",
                self.info.name
            ));
        }
        Ok(())
    }

    /// The filter of a dotted write: the base `_id`, and every object on the path's way exists.
    fn filter(&self, path: &str) -> Document {
        let mut filter = doc! { "_id": self.base_id.clone() };
        let segments: Vec<&str> = path.split('.').collect();
        for end in 1..segments.len() {
            if let Some(prefix) = segments.get(..end) {
                filter.insert(prefix.join("."), doc! { "$exists": true });
            }
        }
        filter
    }

    async fn update(
        &mut self,
        what: &str,
        path: &str,
        value: &Bson,
        update: Document,
        upsert: bool,
    ) -> Result<()> {
        let mut ctx = WriteContext::with_sequential_ids(NOW_MS, 1_000);
        let random = support::entry::CountingRandom::default();
        let (filter, options) = if upsert {
            (
                doc! { "_id": ObjectId::from_bytes([9; 12]) },
                UpdateOptions::upsert(),
            )
        } else {
            (self.filter(path), UpdateOptions::default())
        };
        let prepared = support::entry::update(
            self.info,
            &filter,
            update,
            options,
            Writer::Internal,
            &mut ctx,
            &random,
        );
        let Ok(prepared) = prepared else {
            self.counts.refused += 1;
            return Ok(());
        };
        self.reset().await?;
        let outcome = self
            .store
            .writes(self.info.name)
            .update_one(&prepared)
            .await;
        if outcome.is_err() {
            // The server refused it (a conflict between operators, say): nothing stored.
            self.counts.refused += 1;
            return Ok(());
        }
        self.check(what, path, value).await
    }

    async fn save(
        &mut self,
        what: &str,
        path: &str,
        value: &Bson,
        change: dima_store::mongo::save::Change,
    ) -> Result<()> {
        let mut ctx = WriteContext::with_sequential_ids(NOW_MS, 2_000);
        let random = support::entry::CountingRandom::default();
        self.reset().await?;
        let loaded = self
            .info
            .load_for_save(self.store, &doc! { "_id": self.base_id.clone() }, &mut ctx)
            .await?
            .context("the base document")?;
        let Ok(prepared) = support::entry::save(self.info, &loaded, &[change], &mut ctx, &random)
        else {
            self.counts.refused += 1;
            return Ok(());
        };
        if self
            .store
            .writes(self.info.name)
            .save(&prepared)
            .await
            .is_err()
        {
            self.counts.refused += 1;
            return Ok(());
        }
        self.check(what, path, value).await
    }

    async fn create(&mut self, given: &Document, path: &str, value: &Bson) -> Result<()> {
        let mut ctx = WriteContext::with_sequential_ids(NOW_MS, 3_000);
        let Ok(prepared) = self.info.prepare_create(given, &mut ctx) else {
            self.counts.refused += 1;
            return Ok(());
        };
        let collection = self.store.documents(self.info.name);
        collection.delete_many(doc! {}).await?;
        if self
            .store
            .writes(self.info.name)
            .insert_one(&prepared)
            .await
            .is_err()
        {
            self.counts.refused += 1;
            return Ok(());
        }
        self.check("create", path, value).await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_accepted_write_decodes() -> Result<()> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/mongoose/writes.json");
    let recording: Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let cases = recording
        .get("cases")
        .and_then(Value::as_array)
        .cloned()
        .context("cases")?;
    support::with_store(|store| async move {
        let mut failures = Vec::new();
        let mut summary = BTreeMap::new();
        for info in REGISTRY {
            let given = base_given(&cases, info.name)?;
            if given.is_empty() {
                bail!(
                    "{}: no recorded create case to build the base document from",
                    info.name
                );
            }
            let mut ctx = WriteContext::with_sequential_ids(NOW_MS, 1);
            let base = info
                .prepare_create(&given, &mut ctx)
                .with_context(|| format!("{}: the merged base document is refused", info.name))?
                .document;
            let base_id = base.get("_id").cloned().context("_id")?;
            let mut probe = Probe {
                store: &store,
                info,
                base,
                base_id,
                failures: Vec::new(),
                counts: Counts::default(),
            };
            for path in paths(info.schema) {
                let unset = Bson::Undefined;
                probe
                    .update(
                        "$unset",
                        &path,
                        &unset,
                        doc! { "$unset": { &path: 1 } },
                        false,
                    )
                    .await?;
                probe
                    .save(
                        "save unset",
                        &path,
                        &unset,
                        dima_store::mongo::save::Change::unset(&path),
                    )
                    .await?;
                for value in probes() {
                    let set = doc! { "$set": { &path: value.clone() } };
                    probe
                        .update("$set", &path, &value, set.clone(), false)
                        .await?;
                    probe
                        .update("upsert $set", &path, &value, set, true)
                        .await?;
                    let push = doc! { "$push": { &path: value.clone() } };
                    probe.update("$push", &path, &value, push, false).await?;
                    probe
                        .save(
                            "save set",
                            &path,
                            &value,
                            dima_store::mongo::save::Change::set(&path, value.clone()),
                        )
                        .await?;
                    let mut created = given.clone();
                    if put(&mut created, &path, value.clone()) {
                        probe.create(&created, &path, &value).await?;
                    }
                }
            }
            summary.insert(info.name, (probe.counts.written, probe.counts.refused));
            failures.extend(probe.failures);
        }
        for (name, (written, refused)) in &summary {
            eprintln!("{name:<28} {written:>6} writes decoded, {refused:>6} refused");
        }
        if !failures.is_empty() {
            let shown: Vec<&String> = failures.iter().take(80).collect();
            bail!(
                "{} written documents do not decode:\n{}",
                failures.len(),
                shown
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
        Ok(())
    })
    .await
}

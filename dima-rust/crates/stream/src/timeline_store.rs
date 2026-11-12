//! Store adapter for timeline projections: injected time, checked model writes, five-second
//! wall deadlines, and a cancellation boundary after each confirmed write. No environment reads.
use crate::{Error, bounded};
use bson::{DateTime, Document, doc};
use dima_core::Clock;
use dima_model::CollectionInfo;
use dima_store::mongo::{
    MongoStore, WriteContext,
    update::{Returned, UpdateOptions},
};
use futures_util::TryStreamExt;
use std::{sync::Arc, time::Duration};
#[derive(Clone)]
pub(crate) struct Store {
    pub mongo: MongoStore,
    pub clock: Arc<dyn Clock>,
    pub deadline: Duration,
    #[cfg(feature = "test-util")]
    pub hook: Option<Arc<dyn Fn() -> futures_util::future::BoxFuture<'static, ()> + Send + Sync>>,
}
impl Store {
    pub fn new(mongo: MongoStore, clock: Arc<dyn Clock>) -> Self {
        Self {
            mongo,
            clock,
            deadline: Duration::from_secs(5),
            #[cfg(feature = "test-util")]
            hook: None,
        }
    }
    pub fn now(&self) -> DateTime {
        DateTime::from_millis(self.clock.now_ms())
    }
    pub async fn after_write(&self) {
        #[cfg(feature = "test-util")]
        if let Some(h) = &self.hook {
            h().await;
        }
    }
    pub async fn find(
        &self,
        name: &str,
        filter: Document,
        sort: Document,
        limit: i64,
        skip: u64,
        max: u64,
    ) -> Result<Vec<Document>, Error> {
        bounded(self.deadline, async {
            self.mongo
                .documents(name)
                .find(filter)
                .sort(sort)
                .limit(limit)
                .skip(skip)
                .max_time(Duration::from_millis(max))
                .await?
                .try_collect()
                .await
        })
        .await
    }
    pub async fn update(
        &self,
        info: &'static CollectionInfo,
        filter: Document,
        update: Document,
        upsert: bool,
    ) -> Result<u64, Error> {
        let p = info.prepare_update(
            &filter,
            update,
            UpdateOptions {
                upsert,
                ..Default::default()
            },
            &mut WriteContext::new(self.clock.now_ms()),
        )?;
        let r = bounded(self.deadline, self.mongo.writes(info.name).update_one(&p)).await;
        match r {
            Ok(r) => {
                self.after_write().await;
                Ok(r.matched)
            }
            Err(Error::Write(dima_store::mongo::write::WriteError::Driver(e)))
                if dima_store::mongo::error::is_duplicate_key(&e) =>
            {
                Ok(0)
            }
            Err(e) => Err(e),
        }
    }
    pub async fn modify(
        &self,
        info: &'static CollectionInfo,
        filter: Document,
        update: Document,
        sort: Document,
        journal: bool,
    ) -> Result<Option<Document>, Error> {
        let p = info.prepare_find_one_and_update(
            &filter,
            update,
            UpdateOptions::default(),
            Returned::After,
            &mut WriteContext::new(self.clock.now_ms()),
        )?;
        self.mongo
            .writes(info.name)
            .check("findOneAndUpdate", &p.dropped_paths)?;
        let update = p
            .update
            .ok_or_else(|| Error::Invalid("empty projection update".into()))?;
        let collection = self.mongo.documents(info.name);
        let mut action = collection
            .find_one_and_update(
                p.filter,
                mongodb::options::UpdateModifications::from(update),
            )
            .sort(sort)
            .return_document(mongodb::options::ReturnDocument::After);
        if journal {
            action = action.write_concern(
                mongodb::options::WriteConcern::builder()
                    .w(mongodb::options::Acknowledgment::Nodes(1))
                    .journal(true)
                    .build(),
            );
        }
        let r = bounded(self.deadline, action).await?;
        if r.is_some() {
            self.after_write().await;
        }
        Ok(r)
    }
}
pub(crate) fn number(d: &Document, k: &str) -> f64 {
    d.get(k)
        .and_then(dima_store::mongo::number::read_number)
        .unwrap_or(0.0)
}
pub(crate) fn date(d: &Document, k: &str) -> Result<DateTime, Error> {
    d.get_datetime(k)
        .copied()
        .map_err(|_| Error::Invalid(format!("missing date {k}")))
}
pub(crate) fn text<'a>(d: &'a Document, k: &str) -> &'a str {
    d.get_str(k).unwrap_or("")
}
pub(crate) fn json(d: &Document) -> serde_json::Value {
    dima_store::mongo::json::to_json_value(d)
}
pub(crate) fn window(channel: &str, at: DateTime, inclusive: bool) -> Document {
    doc! {"channelID":channel,"started_at":{"$lte":at},"$or":[{"ended_at":bson::Bson::Null},{"ended_at":if inclusive{doc!{"$gte":at}}else{doc!{"$gt":at}}}]}
}

//! Replayable snapshot and genuine-offline projections; private to the tick coordinator.
use super::*;
impl StreamSessionTick {
    pub(super) async fn apply<Q: JobQueue>(
        &self,
        task: &Task,
        at: DateTime,
        jobs: &QueueProducer<'_, Q>,
    ) -> Result<(), Error> {
        let session = &task.session;
        let id = session.get("_id").cloned().unwrap_or(Bson::Null);
        let base = doc! {"_id":id.clone(),"status":"live","ended_at":Bson::Null,"stream_id":text(session,"stream_id")};
        if let Some(stream) = &task.stream {
            let viewers = stream.viewer_count.unwrap_or(0.0).max(0.0);
            let stream_id = if stream.id.is_empty() {
                text(session, "stream_id")
            } else {
                &stream.id
            };
            let given = doc! {"_id":task.snapshot_id,"channelID":text(session,"channelID"),"session_id":id,"stream_id":stream_id,"captured_at":at,"viewers":viewers,"title":stream.title.as_deref().unwrap_or_default(),"game_name":stream.game_name.as_deref().unwrap_or_default(),"messages":number(session,"messages").max(0.0),"commands":number(session,"commands").max(0.0)};
            let p = snapshots::INFO
                .prepare_create(&given, &mut WriteContext::new(at.timestamp_millis()))?;
            match bounded(
                self.store.deadline,
                self.store.mongo.writes(snapshots::INFO.name).insert_one(&p),
            )
            .await
            {
                Ok(()) => self.store.after_write().await,
                Err(Error::Write(dima_store::mongo::write::WriteError::Driver(e)))
                    if dima_store::mongo::error::is_duplicate_key(&e) => {}
                Err(e) => return Err(e),
            }
            let count = number(session, "sample_count") + 1.0;
            let total = number(session, "sample_total_viewers") + viewers;
            let mut filter = base;
            filter.extend(doc!{"sample_count":captured(session,"sample_count"),"sample_total_viewers":captured(session,"sample_total_viewers")});
            self.store.update(&sessions::INFO,filter,doc!{"$set":{"stream_id":stream_id,"sample_count":count,"sample_total_viewers":total,"average_viewers":(total/count).round(),"peak_viewers":number(session,"peak_viewers").max(viewers),"last_seen_live_at":at,"consecutive_offline_checks":0}},false).await?;
        } else {
            let count = number(session, "consecutive_offline_checks");
            let mut filter = base.clone();
            filter.insert(
                "consecutive_offline_checks",
                captured(session, "consecutive_offline_checks"),
            );
            self.store
                .update(
                    &sessions::INFO,
                    filter,
                    doc! {"$inc":{"consecutive_offline_checks":1}},
                    false,
                )
                .await?;
            if count + 1.0 >= 2.0 {
                let mut filter = base;
                filter.insert("consecutive_offline_checks", count + 1.0);
                self.store.update(&sessions::INFO,filter,doc!{"$set":{"ended_at":at,"status":"orphaned","closure_source":"snapshot","duration_minutes":duration_minutes(date(session,"started_at")?,at)}},false).await?;
                let closed=self.find(sessions::INFO.name,doc!{"_id":session.get("_id").cloned().unwrap_or(Bson::Null),"status":"orphaned","closure_source":"snapshot","ended_at":at}).await?;
                if let Some(closed) = closed.first() {
                    self.lifecycle()
                        .enqueue_post_stream_summary_job(
                            jobs,
                            text(session, "channelID"),
                            closed,
                            "orphaned_session_reconciliation",
                            "collectLiveViewerSnapshots",
                        )
                        .await
                        .map_err(|e| Error::Invalid(e.to_string()))?;
                }
            }
        }
        Ok(())
    }
}

fn captured(d: &Document, key: &str) -> Bson {
    d.get(key)
        .cloned()
        .unwrap_or_else(|| Bson::Document(doc! {"$exists":false}))
}

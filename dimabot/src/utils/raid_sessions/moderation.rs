use super::*;
use mongodb::{
    error::{Error, ErrorKind, WriteFailure},
    options::ReturnDocument,
};

fn duplicate_key(error: &Error) -> bool {
    match error.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(error)) => error.code == 11000,
        ErrorKind::Command(error) => error.code == 11000,
        _ => false,
    }
}

fn follower_filter(request: &Request) -> Document {
    let mut eligibility = vec![doc! {"recordedAt":{"$lte":request.requested_at}}];
    if request.include_future {
        eligibility.push(doc! {"eligibleRequestIDs":&request.id});
    }
    let mut filter = doc! {"sessionID":&request.session,"channelID":&request.channel,
    "queuedRequestIDs":{"$ne":&request.id},"$or":eligibility};
    if !request.user.is_empty() {
        filter.insert("userID", &request.user);
    }
    filter
}

impl RaidSessions {
    async fn cancelled_through(&self, channel: &str) -> Result<i64> {
        Ok(self
            .collection::<Control>("follow_defense_controls")
            .find_one(doc! {"_id":channel})
            .await
            .map_err(|_| "Raid cancellation lookup failed")?
            .map_or(0, |control| control.cancelled_through.timestamp_millis()))
    }

    async fn retain_control(&self, channel: &str, expires: DateTime) -> Result<()> {
        let controls = self.collection::<Document>("follow_defense_controls");
        match controls
            .update_one(
                doc! {"_id":channel},
                doc! {
                    "$max":{"pendingUntil":expires},"$setOnInsert":control_defaults()
                },
            )
            .upsert(true)
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if duplicate_key(&error) => {
                controls
                    .update_one(doc! {"_id":channel}, doc! {"$max":{"pendingUntil":expires}})
                    .await
                    .map_err(|_| "Raid moderation control retain failed")?;
                Ok(())
            }
            Err(_) => Err("Raid moderation control retain failed"),
        }
    }

    async fn enqueue_ban(&self, follower: &Follower, request: &Request) -> Result<()> {
        let now = DateTime::now();
        // Discoverability is durable BEFORE admission. If this or a subsequent
        // command fails, replay uses exactly the same action identity.
        self.retain_control(&follower.channel, request.expires_at)
            .await?;
        let mut data = action_document(follower, request, now);
        let id = data
            .get_str("_id")
            .map_err(|_| "Invalid raid moderation identity")?
            .to_owned();
        // Mongoose's timestamps run after retainControl, even on an existing
        // action. A duplicate enqueue updates updatedAt without resetting work.
        let timestamp = DateTime::now();
        data.insert("createdAt", timestamp);
        let actions = self.collection::<Document>("follow_defense_actions");
        match actions
            .update_one(
                doc! {"_id":&id},
                doc! {"$setOnInsert":data,"$set":{"updatedAt":timestamp}},
            )
            .upsert(true)
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if duplicate_key(&error) => {
                if actions
                    .find_one(doc! {"_id":id})
                    .projection(doc! {"_id":1})
                    .await
                    .map_err(|_| "Raid moderation duplicate lookup failed")?
                    .is_some()
                {
                    Ok(())
                } else {
                    Err("Raid moderation action insert failed")
                }
            }
            Err(_) => Err("Raid moderation action insert failed"),
        }
    }

    async fn admit_request(&mut self, request: &Request, fence: &Document) -> Result<usize> {
        request
            .validate()
            .map_err(|_| "Invalid raid moderation request")?;
        let settings = self
            .database
            .collection::<Settings>("follow_defense_settings")
            .find_one(doc! {"channelID":&request.channel})
            .await
            .map_err(|_| "Raid moderation settings lookup failed")?;
        let disabled = settings.is_some_and(|settings| {
            settings.enabled == Some(false) || settings.attack_mode_enabled == Some(false)
        });
        if request.requested_at.timestamp_millis()
            <= self.cancelled_through(&request.channel).await?
            || disabled
        {
            self.requests()
                .update_one(fence.clone(), doc! {"$set":{"status":"cancelled"}})
                .await
                .map_err(|_| "Raid moderation cancellation failed")?;
            return Ok(0);
        }
        let followers: Vec<Follower> = self
            .followers()
            .find(follower_filter(request))
            .sort(doc! {"followedAt":1,"_id":1})
            .limit(BATCH_SIZE as i64)
            .await
            .map_err(|_| "Raid admission follower lookup failed")?
            .try_collect()
            .await
            .map_err(|_| "Raid admission follower read failed")?;
        for follower in &followers {
            follower
                .validate()
                .map_err(|_| "Invalid raid moderation follower")?;
            self.enqueue_ban(follower, request).await?;
            // Mark only AFTER the action exists; interruption before this mark
            // retries the idempotent upsert. Reattributed followers are fenced.
            self.followers()
                .update_one(
                    doc! {"_id":&follower.id,"sessionID":&request.session},
                    doc! {
                        "$addToSet":{"queuedRequestIDs":&request.id}
                    },
                )
                .await
                .map_err(|_| "Raid admission follower checkpoint failed")?;
        }
        let current = self.state(&request.channel).await?;
        let ongoing = request.include_future
            && current.is_some_and(|state| {
                state.activated(&request.id, DateTime::now().timestamp_millis())
            });
        let full = followers.len() == BATCH_SIZE;
        self.requests()
            .update_one(
                fence.clone(),
                doc! {"$set":{
                    "status":if full||ongoing {"active"} else {"completed"},
                    "nextAttemptAt":date(DateTime::now().timestamp_millis()+if full {0} else {1000})
                }},
            )
            .await
            .map_err(|_| "Raid moderation request checkpoint failed")?;
        Ok(followers.len())
    }

    pub async fn process_requests(&mut self) -> Result<usize> {
        let now = DateTime::now();
        self.requests()
            .update_many(
                doc! {"status":{"$in":["authorizing","pending","active"]},"expiresAt":{"$lte":now}},
                doc! {"$set":{"status":"expired"}},
            )
            .await
            .map_err(|_| "Raid moderation request expiry failed")?;
        if let Some(request) = self
            .requests()
            .find_one(authorizing_filter(now))
            .await
            .map_err(|_| "Raid authorizing request lookup failed")?
        {
            request
                .validate()
                .map_err(|_| "Invalid raid moderation request")?;
            let activated = self.state(&request.channel).await?.is_some_and(|state| {
                state.activated(&request.id, DateTime::now().timestamp_millis())
            });
            self.requests()
                .update_one(
                    doc! {"_id":&request.id,"status":"authorizing"},
                    doc! {
                        "$set":{"status":if activated {"pending"} else {"cancelled"}}
                    },
                )
                .await
                .map_err(|_| "Raid authorizing request recovery failed")?;
        }
        // ObjectId uses random process bytes and a monotonic counter. Its token
        // is opaque to TS; collision resistance and a new token per claim fence
        // completion and unlock against a later owner, just like randomUUID.
        let token = ObjectId::new().to_hex();
        let Some(request)=self.requests().find_one_and_update(request_filter(now),doc! {"$set":{"leaseToken":&token,"lockedUntil":date(now.timestamp_millis()+60_000)}})
            .return_document(ReturnDocument::After).sort(doc! {"nextAttemptAt":1,"requestedAt":1})
            .await.map_err(|_| "Raid moderation request claim failed")? else {return Ok(0);};
        let fence = doc! {"_id":&request.id,"leaseToken":token};
        let result = self.admit_request(&request, &fence).await;
        // Finally semantics match TS. Errors preserve queued action IDs and
        // unmarked followers for safe replay; a hard watchdog retains the lease.
        self.requests()
            .update_one(fence, doc! {"$set":{"lockedUntil":date(0),"leaseToken":""}})
            .await
            .map_err(|_| "Raid moderation request unlock failed")?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(future: bool, user: &str) -> Request {
        Request {
            id: "r".into(),
            channel: "c".into(),
            session: "s".into(),
            user: user.into(),
            include_future: future,
            requested_at: date(10),
            expires_at: date(20),
        }
    }
    #[test]
    fn follower_authority_uses_recorded_cutoff_and_explicit_future_eligibility() {
        assert_eq!(
            follower_filter(&request(false, "")),
            doc! {
                "sessionID":"s","channelID":"c","queuedRequestIDs":{"$ne":"r"},"$or":[{"recordedAt":{"$lte":date(10)}}]
            }
        );
        assert_eq!(
            follower_filter(&request(true, "u")),
            doc! {
                "sessionID":"s","channelID":"c","queuedRequestIDs":{"$ne":"r"},
                "$or":[{"recordedAt":{"$lte":date(10)}},{"eligibleRequestIDs":"r"}],"userID":"u"
            }
        );
    }
}

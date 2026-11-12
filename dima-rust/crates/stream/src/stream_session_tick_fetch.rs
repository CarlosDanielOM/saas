//! Bounded app-token Helix batches. Failures do not authorize offline observations.
use super::*;
impl StreamSessionTick {
    pub async fn fetch_live_streams_by_channel_ids(
        &self,
        twitch: &Twitch,
        channels: &[String],
    ) -> Result<LiveStreams, Error> {
        tokio::time::timeout(
            self.config.tick_deadline,
            self.fetch_streams(twitch, channels),
        )
        .await
        .map_err(|_| Error::Deadline)?
    }
    async fn fetch_streams(
        &self,
        twitch: &Twitch,
        channels: &[String],
    ) -> Result<LiveStreams, Error> {
        if channels.len() > self.config.max_channels {
            return Err(Error::Invalid("Helix input exceeds channel bound".into()));
        }
        let mut seen = HashSet::new();
        let ids: Vec<_> = channels
            .iter()
            .filter(|s| !s.is_empty() && seen.insert(s.as_str()))
            .collect();
        if ids.len() > self.config.max_channels {
            return Err(Error::Invalid("Helix input exceeds channel bound".into()));
        }
        let mut result = LiveStreams::default();
        let mut positions = HashMap::new();
        for batch in ids.chunks(100) {
            let mut request = HelixRequest::get(Path::fixed("/streams"), Auth::App)
                .query("type", "live")
                .timeout(self.config.request_deadline);
            for id in batch {
                request = request.query("user_id", id.as_str());
            }
            let response =
                match tokio::time::timeout(self.config.request_deadline, twitch.helix(request))
                    .await
                {
                    Ok(Ok(v)) => v,
                    _ => break,
                };
            if !response.status().is_success() {
                continue;
            }
            let body = match tokio::time::timeout(
                self.config.request_deadline,
                response.into_response().json::<serde_json::Value>(),
            )
            .await
            {
                Ok(Ok(v)) => v,
                _ => break,
            };
            let Some(data) = body.get("data").and_then(serde_json::Value::as_array) else {
                break;
            };
            if data.len() > 100 {
                break;
            }
            let rows = match serde_json::from_value::<Vec<LiveStream>>(serde_json::Value::Array(
                data.clone(),
            )) {
                Ok(v) => v,
                Err(_) => break,
            };
            if rows.iter().any(|s| {
                !batch.iter().any(|id| id.as_str() == s.user_id)
                    || s.viewer_count.is_some_and(|v| !v.is_finite())
            }) {
                break;
            }
            let paginated = body
                .get("pagination")
                .and_then(|v| v.get("cursor"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|s| !s.is_empty());
            if paginated {
                result
                    .observed
                    .extend(rows.iter().map(|row| row.user_id.clone()));
            } else {
                result.observed.extend(batch.iter().map(|id| (*id).clone()));
            }
            for row in rows {
                if let Some(index) = positions.get(&row.user_id).copied() {
                    result.streams[index] = row;
                } else {
                    positions.insert(row.user_id.clone(), result.streams.len());
                    result.streams.push(row);
                }
            }
        }
        Ok(result)
    }
}

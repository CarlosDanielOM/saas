//! Reward orchestration reads through the shared model and delegates internal API writes.
#![allow(clippy::expect_used)]
mod support;
use anyhow::Result;
use bson::doc;
use dima_model::redemption_rewards::{COLLECTION, INFO};
use dima_store::mongo::WriteContext;
use dima_twitch::{AccessToken, functions::redemptions::*};
use futures_util::future::BoxFuture;
use std::sync::{Arc, Mutex};
use support::*;
struct Api {
    calls: Mutex<Vec<(String, String, RewardUpdate)>>,
    error: bool,
}
impl RewardApi for Api {
    fn update<'a>(
        &'a self,
        channel: &'a str,
        reward: &'a str,
        _token: &'a AccessToken,
        body: RewardUpdate,
    ) -> BoxFuture<'a, Result<bool, RewardApiError>> {
        Box::pin(async move {
            self.calls
                .lock()
                .expect("calls")
                .push((channel.into(), reward.into(), body));
            Ok(self.error)
        })
    }
}
async fn fixture(stores: &Stores) -> Result<()> {
    let prepared=INFO.prepare_create(&doc!{"eventsubID":"e","channelID":"u1","channel":"streamer","rewardID":"r","title":"👋 العربية","prompt":"prompt","originalCost":10,"cost":20,"costChange":5,"returnToOriginalCost":true,"message":"message"},&mut WriteContext::new(NOW_MS))?;
    stores
        .mongo
        .writes(COLLECTION)
        .insert_one(&prepared)
        .await?;
    Ok(())
}
#[tokio::test]
async fn custom_and_reset_costs_use_stored_fields_and_leave_documents_untouched() -> Result<()> {
    with_stores(|stores| async move {
        fixture(&stores).await?;
        insert_user(
            &stores,
            user_document(
                "u1",
                "streamer",
                "access",
                "refresh",
                Some(NOW_MS / 1000 + 3600),
            ),
        )
        .await?;
        let server = twitch_mock(Arc::new(Mutex::new(TwitchState::default())), |_, _| {
            dima_http::testing::MockResponse::new(500)
        })
        .await?;
        let process = process(&stores, &server, fast_timings())?;
        process.twitch.load_streamers().await?;
        set_cache(&stores, "u1", &[("plan_tier", "premium")]).await?;
        let before = stores
            .mongo
            .documents(COLLECTION)
            .find_one(doc! {})
            .await?
            .expect("reward");
        let api = Api {
            calls: Mutex::new(Vec::new()),
            error: false,
        };
        let result = custom_redemption_reward(&process.twitch, &api, "u1", "r").await?;
        assert_eq!(result.message, "Reward updated");
        assert_eq!(result.reward_message.as_deref(), Some("message"));
        assert_eq!(
            api.calls.lock().expect("calls")[0],
            (
                "u1".into(),
                "r".into(),
                RewardUpdate {
                    title: "👋 العربية".into(),
                    prompt: "prompt".into(),
                    cost: 25.0
                }
            )
        );
        let result = reset_redemption_cost(&process.twitch, &api, "u1").await?;
        assert_eq!(result.message, "Costs reset");
        assert_eq!(result.reward_message, None);
        assert_eq!(api.calls.lock().expect("calls")[1].2.cost, 10.0);
        let after = stores
            .mongo
            .documents(COLLECTION)
            .find_one(doc! {})
            .await?
            .expect("reward");
        assert_eq!(before, after);
        let missing = custom_redemption_reward(&process.twitch, &api, "u1", "absent")
            .await
            .expect_err("missing");
        assert_eq!(missing.message, "Reward not found");
        assert_eq!(missing.status, Some(404));
        let failed = Api {
            calls: Mutex::new(Vec::new()),
            error: true,
        };
        let error = custom_redemption_reward(&process.twitch, &failed, "u1", "r")
            .await
            .expect_err("api error");
        assert_eq!(error.message, "Error updating reward");
        assert_eq!(error.status, Some(500));
        assert_eq!(failed.calls.lock().expect("calls").len(), 1);
        assert!(server.requests().is_empty());
        process.twitch.shutdown().await;
        Ok(())
    })
    .await
}

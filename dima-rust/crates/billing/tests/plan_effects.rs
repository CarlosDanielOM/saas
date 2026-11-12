//! The effects of a plan change run one at a time per owner, and a stale one does nothing
//! (item 3 of P2-BILLING-01c, re-check finding N4). Each test writes a throwaway
//! `dima_test_billing_<id>` database (dropped afterwards) and uses Dragonfly database 9 with
//! channel ids no other run uses.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::Result;
use bson::oid::ObjectId;
use bson::{Bson, doc};
use dima_billing::plans::PlanTier;
use dima_billing::plans::entitlements::EntitledPlan;
use dima_billing::plans::projection::{
    EFFECTS_LEASE_WAIT, EffectGuard, PlanEffects, PlanOwnerState, PlanProjection, ProjectionError,
    ProjectionStores, Retention, effects_lease_key, project_polar_plan,
};
use dima_store::mongo::MongoStore;
use futures_util::future::BoxFuture;
use std::sync::Mutex;
use tokio::sync::Notify;

const CUSTOMER: &str = "9b2f4c1e-3a5d-4e6f-8a7b-1c2d3e4f5a6b";
const T0: i64 = 1_793_000_000_000;

/// The retention adjustment as the ledger will run it: it confirms before its destructive step.
/// The effect of `pause`'s tier first says it started and waits for `resume` (once).
#[derive(Default)]
struct Effects {
    applied: Mutex<Vec<PlanTier>>,
    stale: Mutex<Vec<PlanTier>>,
    pause: Mutex<Option<PlanTier>>,
    started: Notify,
    resume: Notify,
}

impl Effects {
    fn pausing(tier: PlanTier) -> Self {
        Self {
            pause: Mutex::new(Some(tier)),
            ..Self::default()
        }
    }
    fn applied(&self) -> Vec<PlanTier> {
        self.applied.lock().unwrap().clone()
    }
}

impl PlanEffects for Effects {
    fn adjust_usage_retention<'a>(
        &'a self,
        _channel_ids: &'a [String],
        tier: PlanTier,
        guard: &'a EffectGuard<'a>,
    ) -> BoxFuture<'a, Result<Retention, String>> {
        Box::pin(async move {
            let pause = {
                let mut pause = self.pause.lock().unwrap();
                if *pause == Some(tier) {
                    *pause = None;
                    true
                } else {
                    false
                }
            };
            if pause {
                self.started.notify_one();
                self.resume.notified().await;
            }
            // Immediately before the destructive step.
            if guard.confirm().await.is_err() {
                self.stale.lock().unwrap().push(tier);
                return Ok(Retention::Stale);
            }
            self.applied.lock().unwrap().push(tier);
            Ok(Retention::Applied)
        })
    }
}

async fn premium_owner(store: &MongoStore, channel: &str) -> PlanOwnerState {
    let id = ObjectId::new();
    let then = bson::DateTime::from_millis(T0 - 86_400_000);
    store
        .documents("users")
        .insert_one(doc! {
            "_id": id, "name": "owner",
            "accounts": [{ "_id": ObjectId::new(), "type": "twitch", "id": channel, "actived": true }],
            "polar_sh_customer_id": CUSTOMER, "plan_tier": "premium", "plan_tier_until": Bson::Null,
            "token_balance": 0, "created_at": then, "updated_at": then, "__v": 0,
        })
        .await
        .unwrap();
    load(store, id).await
}

async fn load(store: &MongoStore, id: ObjectId) -> PlanOwnerState {
    let document = store
        .documents("users")
        .find_one(doc! {"_id": id})
        .await
        .unwrap()
        .unwrap();
    PlanOwnerState::of(&dima_model::decode_document::<dima_model::users::User>(&document).unwrap())
}

fn premium() -> EntitledPlan {
    EntitledPlan {
        plan_tier: PlanTier::Premium,
        until_ms: Some(T0 + 30 * 86_400_000),
    }
}

/// One plan write: `(plan, observed_at, event key)`.
async fn write(
    stores: &ProjectionStores<'_>,
    effects: &Effects,
    owner: &PlanOwnerState,
    (plan, at, key): (EntitledPlan, i64, &str),
) -> Result<PlanProjection, ProjectionError> {
    project_polar_plan(
        stores.clone(),
        effects,
        owner,
        plan,
        at,
        key,
        CUSTOMER,
        &format!("fp-{key}"),
        T0,
        &dima_core::SystemRandom,
    )
    .await
}

/// N4, the review's interleaving: A writes Free and pauses before its retention deletes; its
/// lease runs out; B writes Premium, finishes its retention and clears the pending flag; A
/// resumes. A's retention used to delete the paying channel's history. Now A's confirmation
/// sees B's plan (and the lost lease): A does nothing and says so.
#[tokio::test]
async fn an_older_plans_retention_never_runs_after_a_newer_one() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    support::with_mongo(|store| async move {
        let stores = ProjectionStores {
            mongo: &store,
            dragonfly: &dragonfly,
        };
        let channel = support::channel_id();
        let owner = premium_owner(&store, &channel).await;
        let effects = Effects::pausing(PlanTier::Free);
        let a = write(
            &stores,
            &effects,
            &owner,
            (EntitledPlan::FREE, T0 + 1000, "evt-a"),
        );
        let b = async {
            effects.started.notified().await;
            // A stalls past its lease.
            dragonfly
                .del(&[&effects_lease_key(&owner.id)])
                .await
                .unwrap();
            let b = write(&stores, &effects, &owner, (premium(), T0 + 2000, "evt-b")).await;
            effects.resume.notify_one();
            b
        };
        let (a, b) = tokio::join!(a, b);
        assert_eq!(b?, PlanProjection::Applied);
        assert_eq!(a?, PlanProjection::Superseded);
        assert_eq!(
            effects.applied(),
            [PlanTier::Premium],
            "Free's retention never ran"
        );
        assert_eq!(*effects.stale.lock().unwrap(), [PlanTier::Free]);
        let after = load(&store, owner.id).await;
        assert_eq!(after.plan_tier, "premium");
        assert!(!after.effects_pending, "cleared by the write that won");
        support::cleanup(&dragonfly, &channel).await?;
        Ok(())
    })
    .await
}

/// While one plan change runs its effects, another for the same owner waits, then gives up
/// without writing ([`ProjectionError::EffectsBusy`]); retried afterwards it runs in order.
#[tokio::test]
async fn plan_changes_of_one_owner_run_one_at_a_time() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    support::with_mongo(|store| async move {
        let stores = ProjectionStores {
            mongo: &store,
            dragonfly: &dragonfly,
        };
        let channel = support::channel_id();
        let owner = premium_owner(&store, &channel).await;
        let effects = Effects::pausing(PlanTier::Free);
        let a = write(
            &stores,
            &effects,
            &owner,
            (EntitledPlan::FREE, T0 + 1000, "evt-a"),
        );
        let b = async {
            effects.started.notified().await;
            let started = tokio::time::Instant::now();
            let b = write(&stores, &effects, &owner, (premium(), T0 + 2000, "evt-b")).await;
            assert!(started.elapsed() >= EFFECTS_LEASE_WAIT);
            assert_eq!(
                load(&store, owner.id).await.plan_tier,
                "free",
                "B wrote nothing"
            );
            effects.resume.notify_one();
            b
        };
        let (a, b) = tokio::join!(a, b);
        assert!(matches!(b, Err(ProjectionError::EffectsBusy)), "{b:?}");
        assert_eq!(a?, PlanProjection::Applied);
        // The journal retries B.
        assert_eq!(
            write(&stores, &effects, &owner, (premium(), T0 + 2000, "evt-b")).await?,
            PlanProjection::Applied
        );
        assert_eq!(effects.applied(), [PlanTier::Free, PlanTier::Premium]);
        let after = load(&store, owner.id).await;
        assert_eq!(after.plan_tier, "premium");
        assert!(!after.effects_pending);
        assert!(
            dragonfly
                .get_text(&effects_lease_key(&owner.id))
                .await?
                .is_none(),
            "released"
        );
        support::cleanup(&dragonfly, &channel).await?;
        Ok(())
    })
    .await
}

/// The same with the processes killed between steps: a write whose process dies after it
/// stored the plan (before anything destructive) leaves the pending flag; whatever runs next,
/// the older plan's retention never runs after the newer one, and the flag is cleared by the
/// effects of the write that won.
#[tokio::test]
async fn killed_between_steps_the_effects_still_run_in_order() -> Result<()> {
    let Some(dragonfly) = support::dragonfly(9).await? else {
        return Ok(());
    };
    support::with_mongo(|store| async move {
        let stores = ProjectionStores {
            mongo: &store,
            dragonfly: &dragonfly,
        };
        let older = (EntitledPlan::FREE, T0 + 1000, "evt-a");
        let newer = (premium(), T0 + 2000, "evt-b");

        // A (Free) dies after its write; B (Premium) runs once A's lease expired; A's retry
        // loses the race and runs nothing.
        let channel = support::channel_id();
        let owner = premium_owner(&store, &channel).await;
        let effects = Effects::pausing(PlanTier::Free);
        tokio::select! {
            a = write(&stores, &effects, &owner, older) => panic!("A finished: {a:?}"),
            () = effects.started.notified() => {}
        }
        let stored = load(&store, owner.id).await;
        assert_eq!((stored.plan_tier.as_str(), stored.effects_pending), ("free", true));
        dragonfly.del(&[&effects_lease_key(&owner.id)]).await?;
        assert_eq!(write(&stores, &effects, &owner, newer).await?, PlanProjection::Applied);
        let retried = write(&stores, &effects, &owner, older).await;
        assert!(matches!(retried, Err(ProjectionError::LostRace)), "{retried:?}");
        assert_eq!(effects.applied(), [PlanTier::Premium]);
        let after = load(&store, owner.id).await;
        assert_eq!((after.plan_tier.as_str(), after.effects_pending), ("premium", false));
        support::cleanup(&dragonfly, &channel).await?;

        // A (Free) runs; B (Premium) dies after its write; A's retry loses the race; B's
        // retry redoes its effects and clears the flag.
        let channel = support::channel_id();
        let owner = premium_owner(&store, &channel).await;
        let effects = Effects::pausing(PlanTier::Premium);
        assert_eq!(write(&stores, &effects, &owner, older).await?, PlanProjection::Applied);
        tokio::select! {
            b = write(&stores, &effects, &owner, newer) => panic!("B finished: {b:?}"),
            () = effects.started.notified() => {}
        }
        dragonfly.del(&[&effects_lease_key(&owner.id)]).await?;
        let retried = write(&stores, &effects, &owner, older).await;
        assert!(matches!(retried, Err(ProjectionError::LostRace)), "{retried:?}");
        assert_eq!(write(&stores, &effects, &owner, newer).await?, PlanProjection::Applied);
        assert_eq!(effects.applied(), [PlanTier::Free, PlanTier::Premium]);
        let after = load(&store, owner.id).await;
        assert_eq!((after.plan_tier.as_str(), after.effects_pending), ("premium", false));

        // A (Free) dies while it holds the lease and B's write is refused meanwhile; once the
        // lease expired, A's own retry is current again and applies (Free is the newest plan).
        let channel_c = support::channel_id();
        let owner = premium_owner(&store, &channel_c).await;
        let effects = Effects::pausing(PlanTier::Free);
        tokio::select! {
            a = write(&stores, &effects, &owner, (EntitledPlan::FREE, T0 + 3000, "evt-c")) => panic!("{a:?}"),
            () = effects.started.notified() => {}
        }
        let busy = write(&stores, &effects, &owner, (premium(), T0 + 2500, "evt-old")).await;
        assert!(matches!(busy, Err(ProjectionError::EffectsBusy)), "{busy:?}");
        dragonfly.del(&[&effects_lease_key(&owner.id)]).await?;
        let retried = write(&stores, &effects, &owner, (EntitledPlan::FREE, T0 + 3000, "evt-c")).await?;
        assert_eq!(retried, PlanProjection::Applied);
        assert_eq!(effects.applied(), [PlanTier::Free]);
        assert!(!load(&store, owner.id).await.effects_pending);
        support::cleanup(&dragonfly, &channel).await?;
        support::cleanup(&dragonfly, &channel_c).await?;
        Ok(())
    })
    .await
}

#[test]
fn every_lease_script_is_bounded() {
    for script in dima_billing::plans::projection::effects_lease_scripts() {
        assert!(script.check().is_ok(), "{}", script.name());
    }
}

//! The admin grant (item 2 of P2-BILLING-02c, re-check point S2): one request, one grant. Its
//! identity comes from the request (the admin site's request id, else who grants what to whom
//! and why within a window), its record is reserved in `credittransactions` before anything is
//! sent and kept with its outcome; a repeat answers the first outcome, an unconfirmed one is
//! reconciled by its operation id however late. Polar is a stateful mock that deduplicates
//! events by `external_id` and can lose an answer after storing it; each test has its own
//! `dima_test_billing_<id>` database and Dragonfly database 10 with channel ids no other run uses.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::Result;
use bson::doc;
use bson::oid::ObjectId;
use dima_billing::NoopObserver;
use dima_billing::admin_grant::{
    AdminGrant, AdminGrantError, AdminGrantRequest, AdminGrants, REPEAT_WINDOW_MS, Repeat,
};
use dima_billing::gifts::Interrupt;
use dima_billing::plans::credits_cache::{CreditsCache, PlanOwner, TopUp};
use dima_billing::polar::{AcceptedUsage, Ingest, PolarClient, UsageSink};
use dima_core::{ManualClock, SecretString, SystemRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_model::Private;
use dima_store::dragonfly::Dragonfly;
use dima_store::dragonfly::plan_cache_fence::credits_cache_key;
use dima_store::mongo::MongoStore;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const METER: &str = "5103e79b-fd74-4ba8-a287-f95574f9addf";
const T0: i64 = 1_794_484_800_000;
const DAY: i64 = 24 * 60 * 60 * 1000;

struct NoSink;

impl UsageSink for NoSink {
    fn enqueue_receipt<'a>(&'a self, _: AcceptedUsage<'a>) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn track(&self, _: AcceptedUsage<'_>, _: &Map<String, Value>) {}
}

struct NoLookup;

impl dima_billing::plans::credits_cache::PlanLookup for NoLookup {
    fn current_plan<'a>(
        &'a self,
        _: &'a str,
        _: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Option<PlanOwner>, dima_billing::plans::credits_cache::LookupError>>
    {
        Box::pin(async { Ok(None) })
    }
}

/// Stops the call at one point, as a killed process would.
struct StopAt(&'static str);

impl Interrupt for StopAt {
    fn at(&self, point: &'static str) -> bool {
        point == self.0
    }
}

/// Polar: events stored by external id (credits as negative usage), the customer state from
/// them, answers lost or refusals on request, and how many grants were sent.
#[derive(Clone, Default)]
struct Polar {
    events: Arc<Mutex<Vec<(String, f64)>>>,
    lose: Arc<AtomicUsize>,
    refuse: Arc<AtomicUsize>,
    sent: Arc<AtomicUsize>,
}

impl Polar {
    async fn serve(&self) -> MockServer {
        let server = MockServer::start().await.unwrap();
        let polar = self.clone();
        server.fallback(move |request: &RecordedRequest| polar.answer(request));
        server
    }

    fn answer(&self, request: &RecordedRequest) -> MockResponse {
        if request.path().ends_with("/state") {
            let granted: f64 = self.events.lock().unwrap().iter().map(|(_, c)| -c).sum();
            let body = serde_json::json!({ "active_meters": [{ "meter_id": METER,
                "consumed_units": 0, "credited_units": 1000.0 + granted, "balance": 1000.0 + granted }] });
            return MockResponse::json(200, &body.to_string());
        }
        self.sent.fetch_add(1, Ordering::SeqCst);
        if self.refuse.load(Ordering::SeqCst) > 0 {
            self.refuse.fetch_sub(1, Ordering::SeqCst);
            return MockResponse::json(422, r#"{"detail":[]}"#);
        }
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        let (mut inserted, mut duplicates) = (0, 0);
        {
            let mut events = self.events.lock().unwrap();
            for event in body["events"].as_array().unwrap() {
                let id = event["external_id"].as_str().unwrap().to_owned();
                if events.iter().any(|(known, _)| *known == id) {
                    duplicates += 1;
                } else {
                    inserted += 1;
                    events.push((id, event["metadata"]["credits"].as_f64().unwrap()));
                }
            }
        }
        if self.lose.load(Ordering::SeqCst) > 0 {
            self.lose.fetch_sub(1, Ordering::SeqCst);
            return MockResponse::drop_connection();
        }
        MockResponse::json(
            200,
            &format!(r#"{{"inserted":{inserted},"duplicates":{duplicates}}}"#),
        )
    }

    fn stored(&self) -> usize {
        self.events.lock().unwrap().len()
    }

    fn sent(&self) -> usize {
        self.sent.load(Ordering::SeqCst)
    }
}

struct Env {
    store: MongoStore,
    dragonfly: Dragonfly,
    _server: MockServer,
    polar: PolarClient,
    cache: CreditsCache,
    clock: Arc<ManualClock>,
    channel: String,
    user: ObjectId,
}

impl Env {
    async fn new(store: MongoStore, polar: &Polar) -> Result<Self> {
        let dragonfly = support::dragonfly(10)
            .await?
            .ok_or_else(|| anyhow::anyhow!("dragonfly"))?;
        let server = polar.serve().await;
        let client = PolarClient::new(
            HttpClient::builder().build()?,
            server.provider(PolarClient::provider(&Default::default()))?,
            Some(SecretString::from("t")),
        );
        let clock = Arc::new(ManualClock::new(T0));
        let cache = CreditsCache::new(dragonfly.clone(), clock.clone(), Arc::new(NoopObserver));
        Ok(Self {
            store,
            dragonfly,
            _server: server,
            polar: client,
            cache,
            clock,
            channel: support::channel_id(),
            user: ObjectId::new(),
        })
    }

    fn request(&self, credits: f64) -> AdminGrantRequest {
        AdminGrantRequest {
            user_id: self.user,
            channel_id: self.channel.clone(),
            customer_id: Private::from("cust-admin".to_owned()),
            credits,
            reason: "support".into(),
            admin_login: Some(Private::from("admin".to_owned())),
            request_id: None,
        }
    }

    async fn try_grant(
        &self,
        request: &AdminGrantRequest,
        interrupt: Option<&dyn Interrupt>,
    ) -> Result<AdminGrant, AdminGrantError> {
        let ingest = Ingest {
            polar: &self.polar,
            dragonfly: &self.dragonfly,
            credits: &self.cache,
            sink: &NoSink,
            random: &SystemRandom,
            clock: self.clock.as_ref(),
            observer: &NoopObserver,
        };
        let grants = AdminGrants {
            store: &self.store,
            ingest: &ingest,
            cache: &self.cache,
            plans: &NoLookup,
            polar: &self.polar,
            interrupt,
        };
        let owner = PlanOwner {
            plan_tier: Some("pro".into()),
            polar_sh_customer_id: Some(Private::from("cust-admin".to_owned())),
            ..PlanOwner::default()
        };
        grants.grant(&owner, request).await
    }

    async fn grant(&self, request: &AdminGrantRequest) -> AdminGrant {
        self.try_grant(request, None).await.unwrap()
    }

    async fn cached_balance(&self) -> f64 {
        let raw = self
            .dragonfly
            .get_text(&credits_cache_key(&self.channel))
            .await
            .unwrap()
            .unwrap();
        serde_json::from_str::<Value>(&raw).unwrap()["balance"]
            .as_f64()
            .unwrap()
    }

    /// Every admin grant record, by key.
    async fn records(&self) -> Result<Vec<bson::Document>> {
        let options = mongodb::options::FindOptions::builder()
            .sort(doc! { "idempotencyKey": 1 })
            .build();
        let mut cursor = self
            .store
            .documents("credittransactions")
            .find(doc! { "idempotencyKey": { "$regex": "^admin-ai-grant:" } })
            .with_options(options)
            .await?;
        let mut out = Vec::new();
        while cursor.advance().await? {
            out.push(bson::Document::try_from(cursor.current())?);
        }
        Ok(out)
    }

    async fn cleanup(&self) -> Result<()> {
        support::cleanup(&self.dragonfly, &self.channel).await
    }
}

fn granted(outcome: &AdminGrant) -> (bool, TopUp, Option<Repeat>) {
    match outcome {
        AdminGrant::Granted {
            newly_stored,
            top_up,
            repeat,
            ..
        } => (*newly_stored, *top_up, repeat.clone()),
        other => panic!("not granted: {other:?}"),
    }
}

/// A grant is stored once at Polar, its record kept with its outcome, and the local top-up
/// applied once on the balance verified before it.
#[tokio::test]
async fn a_grant_is_kept_and_topped_up_once_on_the_balance_verified_before_it() -> Result<()> {
    support::with_mongo(|store| async move {
        let polar = Polar::default();
        let env = Env::new(store, &polar).await?;
        let request = env.request(500.0);
        let outcome = env.grant(&request).await;
        let AdminGrant::Granted {
            operation_id,
            before,
            ..
        } = &outcome
        else {
            panic!("{outcome:?}");
        };
        assert_eq!(granted(&outcome), (true, TopUp::Applied, None));
        let before = before.clone().expect("verified before the grant");
        assert_eq!(
            env.cached_balance().await,
            before.for_spending().balance + 500.0
        );
        assert_eq!(polar.stored(), 1);
        let records = env.records().await?;
        assert_eq!(records.len(), 1);
        let record = &records[0];
        let typed = dima_model::decode_document::<
            dima_model::credit_transactions::CreditTransaction,
        >(record)?;
        assert_eq!(typed.user, env.user);
        assert_eq!(typed.kind.as_str(), "manual_credit");
        assert_eq!(typed.amount.0, 500.0);
        assert_eq!(typed.metadata.description, "support");
        assert_eq!(
            typed.metadata.external_reference.as_deref(),
            Some(operation_id.as_str())
        );
        assert_eq!(typed.applied_at.map(|at| at.0), Some(T0), "outcome kept");
        assert!(record.get_str("idempotencyKey")?.ends_with(":0000000001"));
        env.cleanup().await
    })
    .await
}

/// S2, the review's sequence, with the process killed at each step: after the record is
/// reserved, after Polar stored the grant (nothing recorded), after the outcome was recorded
/// (the answer never reached the admin), and with the answer lost on the wire. The identical
/// retry never stores a second grant, never tops up twice, and once the outcome is recorded it
/// sends nothing at all.
#[tokio::test]
async fn the_review_sequence_with_the_process_killed_at_each_step() -> Result<()> {
    support::with_mongo(|store| async move {
        for point in [
            "admin-grant:reserved",
            "admin-grant:sent",
            "admin-grant:recorded",
            "lost answer",
        ] {
            let polar = Polar::default();
            let env = Env::new(store.clone(), &polar).await?;
            let request = env.request(300.0);
            if point == "lost answer" {
                polar.lose.store(1, Ordering::SeqCst);
                assert!(
                    matches!(env.grant(&request).await, AdminGrant::OutcomeUnknown { .. }),
                    "{point}"
                );
            } else {
                let killed = env.try_grant(&request, Some(&StopAt(point))).await;
                assert!(
                    matches!(killed, Err(AdminGrantError::Interrupted(at)) if at == point),
                    "{point}: {killed:?}"
                );
            }
            let sent_before_retry = polar.sent();
            let retry = env.grant(&request).await;
            let (newly, top_up, repeat) = granted(&retry);
            match point {
                // Nothing reached Polar: the retry sends the reserved grant, stored now.
                "admin-grant:reserved" => {
                    assert_eq!(
                        (newly, top_up, repeat.is_some()),
                        (true, TopUp::Applied, false)
                    );
                }
                // Polar stored it: the retry reconciles it by its operation id.
                "admin-grant:sent" | "lost answer" => {
                    assert_eq!(
                        (newly, top_up, repeat.is_some()),
                        (false, TopUp::Refused, false)
                    );
                }
                // The outcome was kept: the retry answers it and sends nothing.
                _ => {
                    assert_eq!(repeat.map(|r| r.granted_at_ms), Some(T0), "{point}");
                    assert_eq!(polar.sent(), sent_before_retry, "{point}: nothing sent");
                }
            }
            assert_eq!(polar.stored(), 1, "{point}: one grant at Polar");
            // A further retry is a repeat of the recorded outcome.
            let again = env.grant(&request).await;
            assert!(granted(&again).2.is_some(), "{point}");
            assert_eq!(polar.stored(), 1, "{point}");
            let records = env.records().await?;
            assert_eq!(records.len(), 1, "{point}");
            assert!(records[0].get_datetime("appliedAt").is_ok(), "{point}");
            store
                .documents("credittransactions")
                .delete_many(doc! {})
                .await?;
            env.cleanup().await?;
        }
        Ok(())
    })
    .await
}

/// Two identical requests at once share one record and one operation id: one grant at Polar,
/// topped up at most once.
#[tokio::test]
async fn two_identical_requests_at_once_grant_once() -> Result<()> {
    support::with_mongo(|store| async move {
        let polar = Polar::default();
        let env = Env::new(store, &polar).await?;
        let request = env.request(250.0);
        let (a, b) = futures_util::future::join(env.grant(&request), env.grant(&request)).await;
        let mut highest = f64::MIN;
        let mut applied = 0;
        for outcome in [&a, &b] {
            let AdminGrant::Granted { before, top_up, .. } = outcome else {
                panic!("{outcome:?}");
            };
            highest = highest.max(
                before
                    .as_ref()
                    .map_or(f64::MIN, |b| b.for_spending().balance),
            );
            applied += usize::from(*top_up == TopUp::Applied);
        }
        assert_eq!(polar.stored(), 1);
        assert!(applied <= 1);
        assert_eq!(env.records().await?.len(), 1);
        assert!(
            env.cached_balance().await <= highest + 250.0,
            "never counted twice"
        );
        env.cleanup().await
    })
    .await
}

/// Inside the window an identical request answers the first outcome (and says how to grant
/// again); another reason is a new grant at once; after the window an identical request is a
/// new grant.
#[tokio::test]
async fn a_repeat_inside_the_window_answers_the_first_outcome_and_after_it_grants_again()
-> Result<()> {
    support::with_mongo(|store| async move {
        let polar = Polar::default();
        let env = Env::new(store, &polar).await?;
        let request = env.request(400.0);
        let first = env.grant(&request).await;
        let AdminGrant::Granted { operation_id, .. } = &first else {
            panic!("{first:?}");
        };
        env.clock.set(T0 + REPEAT_WINDOW_MS - 1);
        let repeat = env.grant(&request).await;
        let AdminGrant::Granted {
            operation_id: repeated_id,
            repeat: Some(repeat),
            ..
        } = &repeat
        else {
            panic!("{repeat:?}");
        };
        assert_eq!(repeated_id, operation_id);
        assert_eq!(
            repeat,
            &Repeat {
                granted_at_ms: T0,
                new_grant_from_ms: Some(T0 + REPEAT_WINDOW_MS),
            }
        );
        assert!(Repeat::HOW_TO_GRANT_AGAIN.contains("different reason"));
        assert_eq!(polar.stored(), 1);
        // Another reason: a new grant now.
        let other = AdminGrantRequest {
            reason: "support, second batch".into(),
            ..request.clone()
        };
        assert!(granted(&env.grant(&other).await).0);
        assert_eq!(polar.stored(), 2);
        // After the window: the identical request is a new grant, in window 2.
        env.clock.set(T0 + REPEAT_WINDOW_MS);
        let later = env.grant(&request).await;
        let AdminGrant::Granted {
            operation_id: later_id,
            newly_stored: true,
            repeat: None,
            ..
        } = &later
        else {
            panic!("{later:?}");
        };
        assert_ne!(later_id, operation_id);
        assert!(later_id.as_str().ends_with("-2"));
        assert_eq!(polar.stored(), 3);
        assert_eq!(env.records().await?.len(), 3);
        env.cleanup().await
    })
    .await
}

/// The answer is lost; the admin retries more than a day later (the old pending key's 24
/// hours, and the window, have passed). The record kept the operation id: the retry reconciles
/// it with Polar instead of granting again.
#[tokio::test]
async fn an_unknown_outcome_retried_after_a_day_is_reconciled_not_granted_again() -> Result<()> {
    support::with_mongo(|store| async move {
        let polar = Polar::default();
        polar.lose.store(1, Ordering::SeqCst);
        let env = Env::new(store, &polar).await?;
        let request = env.request(600.0);
        let AdminGrant::OutcomeUnknown { operation_id, .. } = env.grant(&request).await else {
            panic!("not unknown");
        };
        assert!(env.records().await?[0].get("appliedAt").is_none());
        let later = T0 + DAY + REPEAT_WINDOW_MS + 1;
        env.clock.set(later);
        let retry = env.grant(&request).await;
        let AdminGrant::Granted {
            operation_id: retried,
            newly_stored: false,
            top_up: TopUp::Refused,
            ..
        } = &retry
        else {
            panic!("{retry:?}");
        };
        assert_eq!(retried, &operation_id);
        assert_eq!(polar.stored(), 1);
        let records = env.records().await?;
        assert_eq!(records.len(), 1);
        assert_eq!(
            records[0].get_datetime("appliedAt")?.timestamp_millis(),
            later
        );
        env.cleanup().await
    })
    .await
}

/// Polar refuses the grant: nothing was granted, the record stays unconfirmed, and the retry
/// sends the same grant (one at Polar once it is accepted).
#[tokio::test]
async fn a_refused_grant_stays_unconfirmed_and_the_retry_sends_the_same_grant() -> Result<()> {
    support::with_mongo(|store| async move {
        let polar = Polar::default();
        polar.refuse.store(1, Ordering::SeqCst);
        let env = Env::new(store, &polar).await?;
        let request = env.request(100.0);
        assert!(matches!(
            env.grant(&request).await,
            AdminGrant::Failed { .. }
        ));
        assert_eq!(
            granted(&env.grant(&request).await),
            (true, TopUp::Applied, None)
        );
        assert_eq!(polar.stored(), 1);
        assert_eq!(env.records().await?.len(), 1);
        // Refused before anything is kept: no record.
        assert!(matches!(
            env.grant(&env.request(0.5)).await,
            AdminGrant::Failed { .. }
        ));
        assert_eq!(env.records().await?.len(), 1);
        env.cleanup().await
    })
    .await
}

/// With the admin site's request id: the same id names one grant for ever (a retry days later
/// is a repeat), a new id is a new grant, an id reused for a different request names a different
/// grant (never swallowed by Polar's deduplication), and a malformed id is refused.
#[tokio::test]
async fn a_request_id_names_one_grant() -> Result<()> {
    support::with_mongo(|store| async move {
        let polar = Polar::default();
        let env = Env::new(store, &polar).await?;
        let with_id = |id: &str, credits: f64| AdminGrantRequest {
            request_id: Some(id.to_owned()),
            ..env.request(credits)
        };
        assert!(granted(&env.grant(&with_id("r-1", 200.0)).await).0);
        env.clock.set(T0 + 3 * DAY);
        let repeat = granted(&env.grant(&with_id("r-1", 200.0)).await).2;
        assert_eq!(
            repeat,
            Some(Repeat {
                granted_at_ms: T0,
                new_grant_from_ms: None
            })
        );
        assert_eq!(polar.stored(), 1);
        assert!(granted(&env.grant(&with_id("r-2", 200.0)).await).0);
        assert!(granted(&env.grant(&with_id("r-1", 300.0)).await).0);
        assert_eq!(polar.stored(), 3);
        assert!(matches!(
            env.try_grant(&with_id("r 1", 200.0), None).await,
            Err(AdminGrantError::InvalidRequestId)
        ));
        assert!(env.records().await?.iter().all(|r| {
            r.get_str("idempotencyKey")
                .unwrap()
                .starts_with("admin-ai-grant:req:")
        }));
        env.cleanup().await
    })
    .await
}

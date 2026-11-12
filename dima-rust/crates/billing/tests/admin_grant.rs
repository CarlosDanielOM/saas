//! The admin top-up: an operation id persisted before the grant, the balance verified before
//! it, a local top-up only when Polar stored the grant with this call. Polar is a stateful
//! mock that deduplicates events by `external_id` and can lose an answer after storing it.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use dima_billing::NoopObserver;
use dima_billing::admin_grant::{AdminGrant, AdminGrantRequest, AdminGrants};
use dima_billing::plans::credits_cache::{CreditsCache, PlanOwner, TopUp};
use dima_billing::polar::{AcceptedUsage, Ingest, PolarClient, UsageSink};
use dima_core::{ManualClock, SecretString, SystemRandom};
use dima_http::HttpClient;
use dima_http::testing::{MockResponse, MockServer, RecordedRequest};
use dima_model::Private;
use dima_store::dragonfly::Dragonfly;
use dima_store::dragonfly::plan_cache_fence::credits_cache_key;
use futures_util::future::BoxFuture;
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const METER: &str = "5103e79b-fd74-4ba8-a287-f95574f9addf";

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

/// Polar: events stored by external id (credits as negative usage), the customer state from
/// them, answers lost on request.
#[derive(Clone, Default)]
struct Polar {
    events: Arc<Mutex<Vec<(String, f64)>>>,
    lose: Arc<AtomicUsize>,
    refuse: Arc<AtomicUsize>,
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
}

struct Env {
    dragonfly: Dragonfly,
    server: MockServer,
    polar: PolarClient,
    cache: CreditsCache,
    clock: Arc<ManualClock>,
    channel: String,
}

impl Env {
    async fn new(server: MockServer) -> Option<Self> {
        let dragonfly = support::dragonfly(10).await.unwrap()?;
        let polar = PolarClient::new(
            HttpClient::builder().build().unwrap(),
            server
                .provider(PolarClient::provider(&Default::default()))
                .unwrap(),
            Some(SecretString::from("t")),
        );
        let clock = Arc::new(ManualClock::new(1_794_484_800_000));
        let cache = CreditsCache::new(dragonfly.clone(), clock.clone(), Arc::new(NoopObserver));
        Some(Self {
            dragonfly,
            server,
            polar,
            cache,
            clock,
            channel: support::channel_id(),
        })
    }

    fn request(&self, credits: f64) -> AdminGrantRequest {
        AdminGrantRequest {
            channel_id: self.channel.clone(),
            customer_id: Private::from("cust-admin".to_owned()),
            credits,
            reason: "support".into(),
            admin_login: Some(Private::from("admin".to_owned())),
        }
    }

    async fn grant(&self, request: &AdminGrantRequest) -> AdminGrant {
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
            dragonfly: &self.dragonfly,
            ingest: &ingest,
            cache: &self.cache,
            plans: &NoLookup,
            polar: &self.polar,
            random: &SystemRandom,
        };
        let owner = PlanOwner {
            plan_tier: Some("pro".into()),
            polar_sh_customer_id: Some(Private::from("cust-admin".to_owned())),
            ..PlanOwner::default()
        };
        grants.grant(&owner, request).await.unwrap()
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

    async fn pending(&self, request: &AdminGrantRequest) -> Option<String> {
        self.dragonfly
            .get_text(&request.pending_key())
            .await
            .unwrap()
    }

    async fn cleanup(&self, request: &AdminGrantRequest) {
        support::cleanup(&self.dragonfly, &self.channel)
            .await
            .unwrap();
        self.dragonfly.del(&[&request.pending_key()]).await.unwrap();
    }
}

#[tokio::test]
async fn a_grant_is_topped_up_once_on_the_balance_verified_before_it() {
    let polar = Polar::default();
    let Some(env) = Env::new(polar.serve().await).await else {
        return;
    };
    let request = env.request(500.0);
    let AdminGrant::Granted {
        newly_stored,
        top_up,
        before,
        ..
    } = env.grant(&request).await
    else {
        panic!("not granted");
    };
    assert!(newly_stored);
    assert_eq!(top_up, TopUp::Applied);
    let (_, _, balance) = before.expect("verified before the grant");
    assert_eq!(env.cached_balance().await, balance + 500.0);
    assert_eq!(polar.stored(), 1);
    assert_eq!(
        env.pending(&request).await,
        None,
        "a settled grant releases its id"
    );
    // A deliberate second identical grant is a new grant.
    env.grant(&request).await;
    assert_eq!(polar.stored(), 2);
    env.cleanup(&request).await;
}

/// The answer is lost after Polar stored the grant: the outcome is unknown and the id stays;
/// the admin's retry sends the same grant, Polar deduplicates it, and nothing is added locally
/// (Polar's figure already holds it).
#[tokio::test]
async fn a_lost_answer_and_a_retry_grant_once_and_top_up_nothing_twice() {
    let polar = Polar::default();
    polar.lose.store(1, Ordering::SeqCst);
    let Some(env) = Env::new(polar.serve().await).await else {
        return;
    };
    let request = env.request(500.0);
    let AdminGrant::OutcomeUnknown { operation_id, .. } = env.grant(&request).await else {
        panic!("not unknown");
    };
    assert_eq!(
        env.pending(&request).await.as_deref(),
        Some(operation_id.as_str())
    );
    let AdminGrant::Granted {
        operation_id: retried,
        newly_stored,
        top_up,
        before,
        ..
    } = env.grant(&request).await
    else {
        panic!("not granted");
    };
    assert_eq!(retried, operation_id);
    assert!(!newly_stored);
    assert_eq!(top_up, TopUp::Refused);
    assert_eq!(polar.stored(), 1);
    // What the cache shows is Polar's own figure (which holds the grant): counted once.
    let (_, _, polar_figure) = before.expect("verified");
    assert_eq!(env.cached_balance().await, polar_figure);
    env.cleanup(&request).await;
}

/// Two identical requests at once share the operation id: one grant at Polar.
#[tokio::test]
async fn two_identical_requests_at_once_grant_once() {
    let polar = Polar::default();
    let Some(env) = Env::new(polar.serve().await).await else {
        return;
    };
    let request = env.request(250.0);
    let (a, b) = futures_util::future::join(env.grant(&request), env.grant(&request)).await;
    let mut highest = f64::MIN;
    for outcome in [a, b] {
        let AdminGrant::Granted { before, .. } = outcome else {
            panic!("{outcome:?}");
        };
        highest = highest.max(before.map_or(f64::MIN, |(_, _, b)| b));
    }
    assert_eq!(polar.stored(), 1);
    assert!(
        env.cached_balance().await <= highest + 250.0,
        "never counted twice"
    );
    env.cleanup(&request).await;
}

/// Polar refuses the grant: nothing was granted, the id is released, the next request is new.
#[tokio::test]
async fn a_refused_grant_releases_its_id() {
    let polar = Polar::default();
    polar.refuse.store(1, Ordering::SeqCst);
    let Some(env) = Env::new(polar.serve().await).await else {
        return;
    };
    let request = env.request(100.0);
    assert!(matches!(
        env.grant(&request).await,
        AdminGrant::Failed { .. }
    ));
    assert_eq!(env.pending(&request).await, None);
    assert!(matches!(
        env.grant(&request).await,
        AdminGrant::Granted {
            newly_stored: true,
            ..
        }
    ));
    assert_eq!(polar.stored(), 1);
    env.cleanup(&request).await;
}

#[test]
fn the_release_script_is_bounded() {
    for script in dima_billing::admin_grant::scripts() {
        assert!(script.check().is_ok(), "{}", script.name());
    }
}

#[allow(dead_code)]
fn unused(env: &Env) -> &MockServer {
    &env.server
}

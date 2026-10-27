#![cfg(feature = "plan-cache")]

//! Explicit disposable Dragonfly fixture only; no production helpers or env files.
use dima_rust::utils::plan_cache_fence::*;
use redis::aio::ConnectionManager;
use std::{collections::BTreeMap, time::Duration};
#[allow(dead_code)]
#[path = "fixtures/plan_cache_fence_source.rs"]
mod source;

const OLD: &str = "1793100600000:old";
const NEW: &str = "1793100600001:new";
const NEXT: &str = "1793100600002:next";
const RAW: &str = " { \"balance\": 20, \"available\": true } ";
#[derive(Clone, Debug, Eq, PartialEq)]
enum Cell {
    Text(String),
    Hash(BTreeMap<String, String>),
}
type State = BTreeMap<String, Cell>;
type Snapshot = BTreeMap<String, (Cell, bool)>;
#[derive(Clone, Debug)]
enum Op {
    Write(String),
    Check(String, bool),
    Accept(String, CreditMode, bool),
    Invalidate(String),
    Sync(String, Option<String>, Exhaustion, String),
}
struct Fixture {
    raw: ConnectionManager,
    protocol: PlanCacheFence,
    id: String,
    context: String,
}
impl Fixture {
    async fn new() -> Self {
        let url = std::env::var("PLAN_CACHE_FIXTURE_REDIS_URL")
            .expect("explicit disposable fixture URL required");
        assert_eq!(
            url, "redis://plan-cache-redis-fixture:6379",
            "only task-owned fixture alias accepted"
        );
        let id = std::env::var("PLAN_CACHE_FIXTURE_NAMESPACE")
            .expect("explicit unique fixture namespace required");
        assert!(id.starts_with("plan-cache-fixture-") && id.len() < 70);
        assert!(id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'));
        let client = redis::Client::open(url).unwrap();
        let raw = ConnectionManager::new(client).await.unwrap();
        Self {
            protocol: PlanCacheFence::new(raw.clone()),
            context: format!("billing:credit-packs:context:v1:{id}"),
            raw,
            id,
        }
    }
    fn keys(&self) -> Vec<String> {
        let [canonical, legacy] = exhaustion_cache_keys(&self.id);
        vec![
            plan_cache_fence_key(&self.id),
            account_cache_key(&self.id),
            credits_cache_key(&self.id),
            canonical,
            legacy,
            snapshot_version_key(&self.id),
            ACCOUNTS_CACHE_KEY.into(),
            self.context.clone(),
        ]
    }
    fn seed(&self, fence: Option<&str>) -> State {
        let [canonical, legacy] = exhaustion_cache_keys(&self.id);
        let mut state = BTreeMap::from([
            (
                account_cache_key(&self.id),
                Cell::Hash(BTreeMap::from([
                    ("id".into(), self.id.clone()),
                    ("plan_tier".into(), "premium".into()),
                    ("access_token".into(), "fixture-token".into()),
                    (PLAN_CACHE_VERSION_FIELD.into(), OLD.into()),
                ])),
            ),
            (credits_cache_key(&self.id), Cell::Text(RAW.into())),
            (canonical, Cell::Text("true".into())),
            (legacy, Cell::Text("true".into())),
            (snapshot_version_key(&self.id), Cell::Text(OLD.into())),
            (
                ACCOUNTS_CACHE_KEY.into(),
                Cell::Text("old aggregate".into()),
            ),
            (self.context.clone(), Cell::Text("old context".into())),
        ]);
        if let Some(version) = fence {
            state.insert(plan_cache_fence_key(&self.id), Cell::Text(version.into()));
        }
        state
    }
    async fn reset(&mut self, state: &State) {
        let _: usize = redis::cmd("DEL")
            .arg(self.keys())
            .query_async(&mut self.raw)
            .await
            .unwrap();
        for (key, cell) in state {
            match cell {
                Cell::Text(value) => {
                    let _: () = redis::cmd("SET")
                        .arg(key)
                        .arg(value)
                        .query_async(&mut self.raw)
                        .await
                        .unwrap();
                }
                Cell::Hash(fields) => {
                    let mut command = redis::cmd("HSET");
                    command.arg(key);
                    for (name, value) in fields {
                        command.arg(name).arg(value);
                    }
                    let _: usize = command.query_async(&mut self.raw).await.unwrap();
                    // HSET must retain an existing hash TTL, as in TypeScript.
                    let _: usize = redis::cmd("EXPIRE")
                        .arg(key)
                        .arg(300)
                        .query_async(&mut self.raw)
                        .await
                        .unwrap();
                }
            }
        }
    }
    async fn snapshot(&mut self) -> Snapshot {
        let mut result = BTreeMap::new();
        for key in self.keys() {
            let kind: String = redis::cmd("TYPE")
                .arg(&key)
                .query_async(&mut self.raw)
                .await
                .unwrap();
            let cell = match kind.as_str() {
                "none" => continue,
                "string" => Cell::Text(
                    redis::cmd("GET")
                        .arg(&key)
                        .query_async(&mut self.raw)
                        .await
                        .unwrap(),
                ),
                "hash" => Cell::Hash(
                    redis::cmd("HGETALL")
                        .arg(&key)
                        .query_async(&mut self.raw)
                        .await
                        .unwrap(),
                ),
                _ => panic!("unexpected fixture key type"),
            };
            let ttl: i64 = redis::cmd("TTL")
                .arg(&key)
                .query_async(&mut self.raw)
                .await
                .unwrap();
            assert!(ttl >= -1);
            if key == plan_cache_fence_key(&self.id) || key == snapshot_version_key(&self.id) {
                assert_eq!(ttl, -1, "ordering fences must persist");
            }
            result.insert(key, (cell, ttl >= 0));
        }
        result
    }
    async fn reference(&mut self, op: &Op) -> Acceptance {
        let [canonical, legacy] = exhaustion_cache_keys(&self.id);
        let fence = plan_cache_fence_key(&self.id);
        let account = account_cache_key(&self.id);
        let credits = credits_cache_key(&self.id);
        let list = ACCOUNTS_CACHE_KEY.to_owned();
        let (index, keys, args): (usize, Vec<String>, Vec<String>) = match op {
            Op::Write(version) => (
                0,
                vec![fence, account, list],
                vec![
                    version.clone(),
                    "id".into(),
                    self.id.clone(),
                    "plan_tier".into(),
                    "free".into(),
                    PLAN_CACHE_VERSION_FIELD.into(),
                    version.clone(),
                ],
            ),
            Op::Check(version, publish) => (
                1,
                vec![fence, list],
                vec![
                    version.clone(),
                    if *publish {
                        "[{\"id\":\"fixture\"}]".into()
                    } else {
                        String::new()
                    },
                ],
            ),
            Op::Accept(version, mode, exhausted) => (
                2,
                vec![credits, canonical, legacy, fence],
                vec![
                    version.clone(),
                    RAW.into(),
                    if *mode == CreditMode::Read {
                        "read".into()
                    } else {
                        "write".into()
                    },
                    if *exhausted { "1".into() } else { "0".into() },
                    "600".into(),
                ],
            ),
            Op::Invalidate(version) => (
                3,
                vec![fence, credits, account, list, self.context.clone()],
                vec![version.clone()],
            ),
            Op::Sync(snapshot, raw, exhausted, version) => (
                4,
                vec![
                    credits,
                    canonical,
                    legacy,
                    snapshot_version_key(&self.id),
                    fence,
                ],
                vec![
                    snapshot.clone(),
                    raw.clone().unwrap_or_default(),
                    match exhausted {
                        Exhaustion::Keep => "".into(),
                        Exhaustion::Exhausted => "1".into(),
                        Exhaustion::Available => "0".into(),
                    },
                    "600".into(),
                    version.clone(),
                ],
            ),
        };
        let result: i64 = redis::cmd("EVAL")
            .arg(source::SOURCE_SCRIPTS[index].1)
            .arg(keys.len())
            .arg(keys)
            .arg(args)
            .query_async(&mut self.raw)
            .await
            .unwrap();
        if result == 1 {
            Acceptance::Accepted
        } else {
            assert_eq!(result, 0);
            Acceptance::Rejected
        }
    }
    async fn candidate(&self, op: &Op) -> Acceptance {
        let ttl = TtlSeconds::new(600).unwrap();
        match op {
            Op::Write(version) => {
                self.protocol
                    .write_account(
                        &self.id,
                        version,
                        &[("id", &self.id), ("plan_tier", "free")],
                    )
                    .await
            }
            Op::Check(version, publish) => {
                self.protocol
                    .check_accounts(
                        &[AccountVersion {
                            id: &self.id,
                            version,
                        }],
                        publish.then_some("[{\"id\":\"fixture\"}]"),
                    )
                    .await
            }
            Op::Accept(version, mode, exhausted) => {
                self.protocol
                    .accept_credits(&self.id, version, RAW, *mode, *exhausted, ttl)
                    .await
            }
            Op::Invalidate(version) => {
                self.protocol
                    .invalidate_plan(&self.id, version, &self.context)
                    .await
            }
            Op::Sync(snapshot, raw, exhaustion, version) => {
                self.protocol
                    .sync_credits(
                        &self.id,
                        snapshot,
                        raw.as_deref(),
                        *exhaustion,
                        ttl,
                        version,
                    )
                    .await
            }
        }
        .unwrap()
    }
}

#[tokio::test]
#[ignore = "requires explicit task-owned disposable Dragonfly fixture"]
async fn source_equivalence_races_prepared_scripts_atomic_reads_and_bounds() {
    let mut f = Fixture::new().await;
    let mut cases = 0;
    for fence in [None, Some(""), Some(OLD), Some(NEW), Some(NEXT)] {
        for version in ["", OLD, NEW] {
            let operations = [
                Op::Write(version.into()),
                Op::Check(version.into(), false),
                Op::Check(version.into(), true),
                Op::Accept(version.into(), CreditMode::Read, true),
                Op::Accept(version.into(), CreditMode::Write, false),
                Op::Invalidate(version.into()),
                Op::Sync(
                    OLD.into(),
                    Some("new raw payload".into()),
                    Exhaustion::Exhausted,
                    version.into(),
                ),
                Op::Sync(NEW.into(), None, Exhaustion::Keep, version.into()),
                Op::Sync(
                    NEW.into(),
                    Some(String::new()),
                    Exhaustion::Available,
                    version.into(),
                ),
            ];
            for op in operations {
                let state = f.seed(fence);
                f.reset(&state).await;
                let expected = f.reference(&op).await;
                let snapshot = f.snapshot().await;
                f.reset(&state).await;
                assert_eq!(f.candidate(&op).await, expected, "{op:?}/{fence:?}");
                assert_eq!(f.snapshot().await, snapshot, "{op:?}/{fence:?}");
                cases += 1;
            }
        }
    }
    println!("source-equivalence cases: {cases}");

    // Exact raw comparison rejects even semantically equivalent JSON.
    let state = f.seed(Some(NEW));
    f.reset(&state).await;
    assert_eq!(
        f.protocol
            .accept_credits(
                &f.id,
                NEW,
                "{\"balance\":20,\"available\":true}",
                CreditMode::Read,
                false,
                TtlSeconds::new(600).unwrap()
            )
            .await
            .unwrap(),
        Acceptance::Rejected
    );
    assert_eq!(
        f.snapshot().await[&exhaustion_cache_keys(&f.id)[0]].0,
        Cell::Text("true".into())
    );

    // Mixed writers: source invalidation wins against stale Rust writes and
    // a previously assembled aggregate. Reverse the writer roles as well.
    f.reset(&f.seed(None)).await;
    assert_eq!(
        f.reference(&Op::Invalidate(NEW.into())).await,
        Acceptance::Accepted
    );
    assert_eq!(
        f.candidate(&Op::Write(OLD.into())).await,
        Acceptance::Rejected
    );
    assert_eq!(
        f.candidate(&Op::Check(OLD.into(), true)).await,
        Acceptance::Rejected
    );
    assert_eq!(
        f.candidate(&Op::Accept(OLD.into(), CreditMode::Write, false))
            .await,
        Acceptance::Rejected
    );
    f.reset(&f.seed(None)).await;
    assert_eq!(
        f.candidate(&Op::Invalidate(NEW.into())).await,
        Acceptance::Accepted
    );
    assert_eq!(
        f.reference(&Op::Write(OLD.into())).await,
        Acceptance::Rejected
    );
    assert_eq!(
        f.reference(&Op::Sync(
            NEXT.into(),
            Some(RAW.into()),
            Exhaustion::Available,
            OLD.into()
        ))
        .await,
        Acceptance::Rejected
    );

    // Every included account is checked before publication, not just the first.
    f.reset(&f.seed(Some(NEW))).await;
    assert_eq!(
        f.protocol
            .check_accounts(
                &[
                    AccountVersion {
                        id: "missing-fence",
                        version: ""
                    },
                    AccountVersion {
                        id: &f.id,
                        version: OLD
                    }
                ],
                Some("stale aggregate")
            )
            .await
            .unwrap(),
        Acceptance::Rejected
    );
    let current: String = redis::cmd("GET")
        .arg(ACCOUNTS_CACHE_KEY)
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(current, "old aggregate");

    // Atomic reads retain metadata for a final publication check, but omit it
    // from public fields. They never attempt Mongo hydration.
    f.reset(&f.seed(Some(OLD))).await;
    let AccountRead::Accepted(account) = f.protocol.read_account(&f.id).await.unwrap() else {
        panic!("account expected");
    };
    assert_eq!(account.version(), OLD);
    assert!(
        !account
            .public_fields()
            .any(|(name, _)| name == PLAN_CACHE_VERSION_FIELD)
    );
    assert_eq!(
        f.protocol.read_account("missing-fixture").await.unwrap(),
        AccountRead::Missing
    );
    let _: () = redis::cmd("SET")
        .arg(plan_cache_fence_key(&f.id))
        .arg(NEW)
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(
        f.protocol.read_account(&f.id).await.unwrap(),
        AccountRead::Stale
    );
    let reads = f
        .protocol
        .read_accounts(&["missing-fixture", &f.id])
        .await
        .unwrap();
    assert_eq!(reads, vec![AccountRead::Missing, AccountRead::Stale]);
    assert_eq!(
        f.protocol
            .read_accounts(&[f.id.as_str(); MAX_READ_BATCH_ACCOUNTS])
            .await
            .unwrap(),
        vec![AccountRead::Stale; MAX_READ_BATCH_ACCOUNTS]
    );

    // No write or scan is needed to recover a flushed script cache. Batches
    // can safely repeat reads after confirmed NOSCRIPT; final publish is separate.
    let _: () = redis::cmd("SCRIPT")
        .arg("FLUSH")
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(
        f.protocol.read_accounts(&[&f.id]).await.unwrap(),
        vec![AccountRead::Stale]
    );
    assert_eq!(
        f.protocol
            .check_accounts(
                &[AccountVersion {
                    id: &f.id,
                    version: NEW
                }],
                None
            )
            .await
            .unwrap(),
        Acceptance::Accepted
    );
    let _: () = redis::cmd("SCRIPT")
        .arg("FLUSH")
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(
        f.protocol
            .write_account(
                &f.id,
                NEW,
                &[("id", &f.id), (PLAN_CACHE_VERSION_FIELD, "tampered")]
            )
            .await
            .unwrap(),
        Acceptance::Accepted
    );
    let AccountRead::Accepted(account) = f.protocol.read_account(&f.id).await.unwrap() else {
        panic!("current account expected");
    };
    assert_eq!(account.version(), NEW);
    assert_eq!(f.protocol.read_accounts(&[]).await.unwrap(), Vec::new());
    assert_eq!(
        f.protocol
            .read_accounts(&[f.id.as_str(); MAX_READ_BATCH_ACCOUNTS + 1])
            .await,
        Err(FenceError::InputTooLarge)
    );
    let oversized = "x".repeat(MAX_VALUE_BYTES + 1);
    assert_eq!(
        f.protocol
            .write_account(&f.id, NEW, &[("data", &oversized)])
            .await,
        Err(FenceError::InputTooLarge)
    );

    let _: usize = redis::cmd("HSET")
        .arg(account_cache_key(&f.id))
        .arg("large")
        .arg("x".repeat(MAX_READ_ACCOUNT_BYTES))
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(
        f.protocol.read_account(&f.id).await,
        Err(FenceError::AccountTooLarge)
    );
    assert_eq!(
        f.protocol.read_accounts(&[&f.id]).await,
        Err(FenceError::AccountTooLarge)
    );
    f.reset(&f.seed(None)).await;
    let mut command = redis::cmd("HSET");
    command.arg(account_cache_key(&f.id));
    for index in 0..MAX_ACCOUNT_FIELDS {
        command.arg(format!("extra-{index}")).arg("value");
    }
    let _: usize = command.query_async(&mut f.raw).await.unwrap();
    assert_eq!(
        f.protocol.read_account(&f.id).await,
        Err(FenceError::AccountTooLarge)
    );
    f.reset(&f.seed(None)).await;
    let _: usize = redis::cmd("HSET")
        .arg(account_cache_key(&f.id))
        .arg("id")
        .arg("wrong-id")
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(
        f.protocol.read_account(&f.id).await,
        Err(FenceError::Protocol)
    );
    assert_eq!(
        f.protocol.read_accounts(&[&f.id]).await,
        Err(FenceError::Protocol)
    );

    // Exercise every prepared mutation after confirmed script-cache loss.
    for op in [
        Op::Write(NEW.into()),
        Op::Check(NEW.into(), true),
        Op::Accept(NEW.into(), CreditMode::Write, false),
        Op::Invalidate(NEW.into()),
        Op::Sync(
            NEW.into(),
            Some(RAW.into()),
            Exhaustion::Available,
            NEW.into(),
        ),
    ] {
        f.reset(&f.seed(None)).await;
        let _: () = redis::cmd("SCRIPT")
            .arg("FLUSH")
            .query_async(&mut f.raw)
            .await
            .unwrap();
        assert_eq!(f.candidate(&op).await, Acceptance::Accepted);
    }
    // Actual concurrent old publication/new invalidation must never leave the
    // old account or aggregate behind, regardless of server execution order.
    for _ in 0..16 {
        f.reset(&f.seed(None)).await;
        let protocol = f.protocol.clone();
        let id = f.id.clone();
        let fields = [("id", id.as_str())];
        let write = protocol.write_account(&id, OLD, &fields);
        let op = Op::Invalidate(NEW.into());
        let (write, invalidation) = tokio::join!(write, f.reference(&op));
        assert!(write.is_ok());
        assert_eq!(invalidation, Acceptance::Accepted);
        let snapshot = f.snapshot().await;
        assert_eq!(
            snapshot[&plan_cache_fence_key(&f.id)].0,
            Cell::Text(NEW.into())
        );
        assert!(!snapshot.contains_key(&account_cache_key(&f.id)));
        assert!(!snapshot.contains_key(ACCOUNTS_CACHE_KEY));
    }
    // Warm repeated operations send script hashes, not repeated EVAL bodies.
    f.reset(&f.seed(None)).await;
    assert_eq!(
        f.candidate(&Op::Write(NEW.into())).await,
        Acceptance::Accepted
    );
    let before: String = redis::cmd("INFO")
        .arg("commandstats")
        .query_async(&mut f.raw)
        .await
        .unwrap();
    for _ in 0..8 {
        assert_eq!(
            f.candidate(&Op::Write(NEW.into())).await,
            Acceptance::Accepted
        );
    }
    let after: String = redis::cmd("INFO")
        .arg("commandstats")
        .query_async(&mut f.raw)
        .await
        .unwrap();
    fn calls(info: &str, name: &str) -> u64 {
        info.lines()
            .find_map(|line| {
                line.strip_prefix(&format!("cmdstat_{name}:calls="))
                    .and_then(|rest| rest.split(',').next())
                    .and_then(|value| value.parse().ok())
            })
            .unwrap_or(0)
    }
    assert_eq!(calls(&after, "evalsha") - calls(&before, "evalsha"), 8);
    assert_eq!(calls(&after, "eval") - calls(&before, "eval"), 0);
    // The largest supported aggregate is still checked/published in one script.
    let _: () = redis::cmd("SET")
        .arg(plan_cache_fence_key(&f.id))
        .arg(NEW)
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(
        f.protocol.check_accounts(&[], None).await.unwrap(),
        Acceptance::Accepted
    );
    let mut versions = vec![
        AccountVersion {
            id: &f.id,
            version: NEW
        };
        MAX_CHECK_ACCOUNTS
    ];
    let before: String = redis::cmd("INFO")
        .arg("commandstats")
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(
        f.protocol
            .check_accounts(&versions, Some("all versions validated"))
            .await
            .unwrap(),
        Acceptance::Accepted
    );
    let after: String = redis::cmd("INFO")
        .arg("commandstats")
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(calls(&after, "evalsha") - calls(&before, "evalsha"), 1);
    versions.last_mut().unwrap().version = OLD;
    assert_eq!(
        f.protocol
            .check_accounts(&versions, Some("must not replace current list"))
            .await
            .unwrap(),
        Acceptance::Rejected
    );
    versions.push(AccountVersion {
        id: &f.id,
        version: NEW,
    });
    assert_eq!(
        f.protocol.check_accounts(&versions, None).await,
        Err(FenceError::InputTooLarge)
    );
    drop(versions);
    let aggregate: String = redis::cmd("GET")
        .arg(ACCOUNTS_CACHE_KEY)
        .query_async(&mut f.raw)
        .await
        .unwrap();
    assert_eq!(aggregate, "all versions validated");
    assert!(matches!(
        PlanCacheFence::with_deadline(f.raw.clone(), Duration::ZERO),
        Err(FenceError::InvalidDeadline)
    ));
    let _: usize = redis::cmd("DEL")
        .arg(f.keys())
        .query_async(&mut f.raw)
        .await
        .unwrap();
    println!(
        "mixed writers, raw equality, persistent fences, SHA reload, read states, read limits and corrupt identity verified"
    );
}

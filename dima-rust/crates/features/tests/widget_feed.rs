//! Golden JSON from the nine real feed files; no hand-edited expectations.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use anyhow::{Context, Result};
use dima_core::{ManualClock, SeededRandom};
use dima_features::widget_feed::{
    badges::{BadgeCache, BadgeSource, Badges},
    model,
    subscriptions::{ModerationEnsurer, ModerationSource},
};
use dima_http::guard::BoxFuture;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
fn cases() -> Result<Vec<Value>> {
    include_str!("widget_feed_reference.jsonl")
        .lines()
        .map(|l| Ok(serde_json::from_str(l)?))
        .collect()
}
fn same(a: &Value, b: &Value) {
    assert_eq!(a, b);
    assert_eq!(
        dima_text::to_js_json(a),
        dima_text::to_js_json(b),
        "field ordering"
    );
}
fn wrap(m: model::FeedMessage, now: i64) -> Value {
    json!([{"topic":"widget-feed","message":{"channel":m.channel,"type":m.kind,"data":m.data,"timestamp":now}}])
}
#[test]
fn widget_feed_recorded_json_shapes_and_field_order() -> Result<()> {
    let cases = cases()?;
    let now = cases[0]["now"].as_i64().context("clock")?;
    for case in cases.iter().skip(1) {
        let i = &case["input"];
        let actual = match case["op"].as_str().context("op")? {
            "chat" => {
                let badges: BTreeMap<String, Value> = serde_json::from_value(i["badges"].clone())?;
                model::normalize_chat(&i["event"], &badges, now)?
            }
            "delete" => model::normalize_delete(i)?,
            "clear" => model::normalize_clear(i["type"].as_str().context("type")?, &i["event"])?,
            "signal" => model::build_signal(
                &model::SignalInput {
                    name: i["name"].as_str().context("name")?.into(),
                    value: i["value"].as_str().context("value")?.into(),
                    user: i["user"].clone(),
                    source: i["source"].clone(),
                    target: i["target"].as_str().map(str::to_owned),
                },
                i["id"].as_str(),
                now,
                &SeededRandom::new(1),
            )?,
            "signal_error" => json!(model::signal_error(
                i["name"].as_str().context("name")?,
                i["value"].as_str().context("value")?,
                i["target"].as_str()
            )),
            "replay" => json!(model::replay_chat(
                i["entries"].as_array().context("history")?,
                i["limit"].as_u64().context("limit")? as usize,
                now
            )?),
            "pet" => match model::pet_event(
                &i["request"],
                i["phase"].as_str().context("phase")?,
                i["status"].as_str(),
                now,
            )? {
                Some(m) => wrap(m, now),
                None => json!([]),
            },
            "duel" => wrap(
                model::duel_event(
                    i["channel"].as_str().context("channel")?,
                    &i["run"],
                    i["phase"].as_str().context("phase")?,
                    now,
                )?,
                now,
            ),
            "session" => wrap(model::session_refresh("1001"), now),
            _ => continue,
        };
        if i["scalar_limit"] == true {
            assert_eq!(
                case["result"]["text"]
                    .as_str()
                    .context("legacy cut")?
                    .chars()
                    .count(),
                1000
            );
            assert_eq!(actual["text"], i["event"]["message"]["text"]);
            let mut expected = case["result"].clone();
            expected["text"] = actual["text"].clone();
            expected["parts"][0]["text"] = actual["parts"][0]["text"].clone();
            same(&actual, &expected);
        } else {
            same(&actual, &case["result"]);
        }
    }
    Ok(())
}
#[test]
fn widget_feed_recording_provenance() -> Result<()> {
    let f = cases()?;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../dimabot/src");
    for (file, hash) in f[0]["sources"].as_object().context("sources")? {
        assert_eq!(
            dima_core::crypto::sha256(std::fs::read(root.join(file))?).hex(),
            hash.as_str().context("hash")?
        );
    }
    Ok(())
}
struct Remote {
    variant: String,
    state: Mutex<(Vec<Value>, Vec<Value>)>,
}
fn remote(kind: &str, status: &str, id: &str) -> Value {
    json!({"id":id,"type":kind,"status":status,"version":"1","condition":{"broadcaster_user_id":"1001","user_id":"bot"},"transport":{"method":"webhook","callback":"https://subscriptions.domdimabot.com/eventsub"},"created_at":"2026-11-12T00:00:00Z","cost":0})
}
impl ModerationSource for Remote {
    fn account<'a>(&'a self, c: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            self.state.lock().unwrap().1.push(json!(["account", c]));
            Ok((self.variant != "missing-account").then(|| "Channel".into()))
        })
    }
    fn inspect<'a>(&'a self, c: &'a str) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let mut s = self.state.lock().unwrap();
            s.1.push(json!(["inspect", c]));
            Ok(json!({"data":s.0,"complete":self.variant!="incomplete"}))
        })
    }
    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.state.lock().unwrap().1.push(json!(["remove", id]));
            if self.variant == "remove-failed" {
                Err("injected".into())
            } else {
                Ok(())
            }
        })
    }
    fn subscribe<'a>(
        &'a self,
        c: &'a str,
        k: &'a str,
        b: &'a str,
    ) -> BoxFuture<'a, Result<Value, u16>> {
        Box::pin(async move {
            let mut s = self.state.lock().unwrap();
            s.1.push(json!(["subscribe",c,k,"1",{"broadcaster_user_id":c,"user_id":b},null,{"ignoreExisting":true}]));
            if self.variant == "forbidden" {
                return Err(403);
            }
            let conflict = self.variant == "conflict";
            let r = remote(
                k,
                if conflict {
                    "enabled"
                } else {
                    "webhook_callback_verification_pending"
                },
                &if conflict {
                    format!("conflict-{k}")
                } else {
                    k.into()
                },
            );
            s.0.push(r.clone());
            if conflict { Err(409) } else { Ok(r) }
        })
    }
    fn adopt<'a>(
        &'a self,
        r: &'a Value,
        c: &'a str,
        n: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.state.lock().unwrap().1.push(json!(["adopt", r, c, n]));
            Ok(())
        })
    }
}
#[tokio::test]
async fn widget_feed_remote_subscription_recordings() -> Result<()> {
    for case in cases()?.iter().filter(|c| c["op"] == "moderation") {
        let i = &case["input"];
        let source = Arc::new(Remote {
            variant: i["variant"].as_str().context("variant")?.into(),
            state: Mutex::new((serde_json::from_value(i["seed"].clone())?, Vec::new())),
        });
        let ensure = ModerationEnsurer::new(source.clone(), "bot".into());
        let first = ensure.ensure("1001").await;
        let second = if case["result"]["second"].is_null() {
            Value::Null
        } else {
            ensure.ensure("1001").await
        };
        same(
            &json!({"first":first,"second":second,"calls":source.state.lock().unwrap().1}),
            &case["result"],
        );
    }
    Ok(())
}
struct BadgeMock {
    bodies: Value,
    state: Mutex<(bool, Vec<String>)>,
}
impl BadgeSource for BadgeMock {
    fn fetch<'a>(&'a self, c: Option<&'a str>) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            let k = if c.is_none() { "global" } else { "channel" };
            let mut s = self.state.lock().unwrap();
            s.1.push(k.into());
            if s.0 {
                Err("injected".into())
            } else {
                Ok(self.bodies[k].clone())
            }
        })
    }
}
#[tokio::test]
async fn widget_feed_badge_cache_recording() -> Result<()> {
    let cases = cases()?;
    let now = cases[0]["now"].as_i64().context("now")?;
    let case = cases
        .iter()
        .find(|c| c["op"] == "badges")
        .context("badges")?;
    let source = Arc::new(BadgeMock {
        bodies: case["input"]["bodies"].clone(),
        state: Mutex::new((false, Vec::new())),
    });
    let clock = ManualClock::new(now);
    let cache = BadgeCache::new(source.clone(), Arc::new(clock.clone()));
    let mut results = Vec::new();
    results.push(json!(cache.lookup("1001").await?));
    results.push(json!(cache.lookup("1001").await?));
    clock.set(now + 3600001);
    source.state.lock().unwrap().0 = true;
    results.push(json!(cache.lookup("1001").await?));
    same(
        &json!({"results":results,"fetches":source.state.lock().unwrap().1}),
        &case["result"],
    );
    Ok(())
}
#[test]
fn widget_feed_bounds_and_unicode() -> Result<()> {
    assert_eq!(model::signal_error("ok", &"👋".repeat(500), None), None);
    assert_eq!(
        model::signal_error("ok", &"👋".repeat(501), None),
        Some("widget_signal_too_long")
    );
    assert!(model::bound(&json!({"text":"x".repeat(65537)})).is_err());
    let mut deep = json!(true);
    for _ in 0..20 {
        deep = json!({"x":deep});
    }
    assert!(model::bound(&deep).is_err());
    assert!(model::replay_chat(&[], 101, 0).is_err());
    Ok(())
}

struct SlowRemote {
    inner: Remote,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl ModerationSource for SlowRemote {
    fn account<'a>(&'a self, c: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        self.inner.account(c)
    }
    fn inspect<'a>(&'a self, c: &'a str) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(async move {
            self.entered.notify_one();
            self.release.notified().await;
            self.inner.inspect(c).await
        })
    }
    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), String>> {
        self.inner.remove(id)
    }
    fn subscribe<'a>(
        &'a self,
        c: &'a str,
        k: &'a str,
        b: &'a str,
    ) -> BoxFuture<'a, Result<Value, u16>> {
        self.inner.subscribe(c, k, b)
    }
    fn adopt<'a>(
        &'a self,
        r: &'a Value,
        c: &'a str,
        n: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        self.inner.adopt(r, c, n)
    }
}
#[tokio::test]
async fn widget_feed_overlapping_moderation_activation_is_coalesced() -> Result<()> {
    let source = Arc::new(SlowRemote {
        inner: Remote {
            variant: "empty".into(),
            state: Mutex::new((Vec::new(), Vec::new())),
        },
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let ensure = Arc::new(ModerationEnsurer::new(source.clone(), "bot".into()));
    let a = ensure.clone();
    let first =
        tokio_util::task::AbortOnDropHandle::new(tokio::spawn(
            async move { a.ensure("1001").await },
        ));
    source.entered.notified().await;
    let b = ensure.clone();
    let second =
        tokio_util::task::AbortOnDropHandle::new(tokio::spawn(
            async move { b.ensure("1001").await },
        ));
    tokio::task::yield_now().await;
    source.release.notify_one();
    let (first, second) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        Ok::<_, anyhow::Error>((first.await?, second.await?))
    })
    .await??;
    same(&first, &second);
    assert_eq!(first["ok"], true);
    let state = source.inner.state.lock().unwrap();
    assert_eq!(state.1.iter().filter(|c| c[0] == "inspect").count(), 1);
    assert_eq!(state.1.iter().filter(|c| c[0] == "subscribe").count(), 3);
    Ok(())
}

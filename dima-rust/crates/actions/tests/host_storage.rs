//! The host's storage against the local stores: where each kind of variable lands (the
//! reference's documents and keys exactly), what is read back (legacy scoped values, deletion
//! tombstones), the plan gate, the bounds, and two processes racing on the same counter and on
//! the same new document.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::Result;
use bson::{Bson, Document, doc};
use dima_actions::delivery::{RenderError, RenderInput};
use dima_actions::runner::{
    CommandOutcome, CommandRequest, ExecutionAuthorization, ExecutionOrigin,
};
use dima_commands::permissions::UserIdentity;
use dima_engine::value::Value;
use dima_store::dragonfly::Ttl;
use futures_util::TryStreamExt;
use support::*;

const CHANNEL: &str = "1001";

fn chat_event() -> Value {
    Value::from(serde_json::json!({
        "broadcaster_user_id": CHANNEL,
        "broadcaster_user_login": "streamer",
        "broadcaster_user_name": "Streamer",
        "chatter_user_id": "5001",
        "chatter_user_login": "viewerone",
        "chatter_user_name": "ViewerOne",
        "message_id": "chat-1",
        "message": {"text": "!x"},
        "badges": [],
    }))
}

fn input() -> RenderInput {
    RenderInput {
        event_data: chat_event(),
        ..RenderInput::new(CHANNEL)
    }
}

async fn variables(stores: &Stores) -> Result<Vec<Document>> {
    let mut found: Vec<Document> = stores
        .mongo
        .documents("astvariables")
        .find(doc! {})
        .sort(doc! { "userId": 1 })
        .await?
        .try_collect()
        .await?;
    for document in &mut found {
        document.remove("_id");
        for stamp in ["createdAt", "updatedAt"] {
            let value = document.remove(stamp);
            assert_eq!(
                value,
                Some(Bson::DateTime(bson::DateTime::from_millis(NOW_MS))),
                "{stamp} is the write's time"
            );
        }
    }
    Ok(found)
}

#[test]
fn variables_land_where_the_reference_writes_them() -> Result<()> {
    run(with_stores(|stores| async move {
        insert_user(&stores, CHANNEL, "streamer", "premium").await?;
        let twitch = TwitchMock::start().await?;
        let process = process(&stores, &twitch, seeded(1))?;
        let rendered = process
            .delivery
            .render(
                "%(*score 5)%(**pts 3)%(**pts(@Other) 7)a=%(*score) b=%(**pts) c=%(**pts(other))",
                input(),
            )
            .await?;
        assert_eq!(rendered.text, "a=5 b=3 c=7");
        let found = variables(&stores).await?;
        let expected = [
            doc! { "channelID": CHANNEL, "scopeName": "global", "scopeType": "global", "userLogin": "", "__v": 0, "userId": "", "variables": { "score": "5" } },
            doc! { "channelID": CHANNEL, "scopeName": "global", "scopeType": "global", "userLogin": "viewerone", "__v": 0, "userId": "5001", "variables": { "pts": "3" } },
            doc! { "channelID": CHANNEL, "scopeName": "global", "scopeType": "global", "userLogin": "other", "__v": 0, "userId": "login:other", "variables": { "pts": "7" } },
        ];
        assert_eq!(found.len(), 3, "{found:#?}");
        for want in expected {
            let have = found
                .iter()
                .find(|have| have.get("userId") == want.get("userId"))
                .expect("document");
            let mut have = have.clone();
            let mut want = want.clone();
            // Field order is MongoDB's (upsert: equality fields, then $setOnInsert, then $set).
            have.remove("__v");
            want.remove("__v");
            let sorted = |d: &Document| {
                let mut v: Vec<_> = d.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                v.sort_by(|a, b| a.0.cmp(&b.0));
                v
            };
            assert_eq!(sorted(&have), sorted(&want));
        }
        // A second process reads them back (nothing is cached in a process), and a deletion
        // leaves the reference's tombstone.
        let other = process_with_seed(&stores, &twitch, 2)?;
        let read = other
            .delivery
            .render("%del(*score)[%(*score)]%(**pts)", input())
            .await?;
        assert_eq!(read.text, "[]3");
        let channel = stores
            .mongo
            .documents("astvariables")
            .find_one(doc! { "userId": "" })
            .await?
            .unwrap();
        assert_eq!(channel.get_document("variables")?, &doc! { "score": "" });
        assert!(twitch.unexpected().is_empty());
        Ok(())
    }))
}

fn process_with_seed(stores: &Stores, twitch: &TwitchMock, seed: u64) -> Result<Process> {
    process(stores, twitch, seeded(seed))
}

#[test]
fn legacy_scoped_values_are_read_until_a_global_one_exists() -> Result<()> {
    run(with_stores(|stores| async move {
        insert_user(&stores, CHANNEL, "streamer", "pro").await?;
        let twitch = TwitchMock::start().await?;
        let process = process(&stores, &twitch, seeded(3))?;
        let legacy = |scope: &str, value: &str, at: i64| {
            doc! {
                "channelID": CHANNEL, "scopeType": "command", "scopeName": scope,
                "userId": "", "userLogin": "", "variables": { "x": value },
                "createdAt": bson::DateTime::from_millis(at), "updatedAt": bson::DateTime::from_millis(at), "__v": 0,
            }
        };
        let collection = stores.mongo.documents("astvariables");
        collection
            .insert_one(legacy("hola", "older", NOW_MS - 10_000))
            .await?;
        collection
            .insert_one(legacy("adios", "newest", NOW_MS - 1_000))
            .await?;
        assert_eq!(
            process.delivery.render("%(*x)", input()).await?.text,
            "newest"
        );
        // A global tombstone stops the fallback.
        process.delivery.render("%del(*x)", input()).await?;
        assert_eq!(
            process.delivery.render("[%(*x)]", input()).await?.text,
            "[]"
        );
        Ok(())
    }))
}

#[test]
fn free_channels_read_but_never_write_database_variables() -> Result<()> {
    run(with_stores(|stores| async move {
        insert_user(&stores, CHANNEL, "streamer", "free").await?;
        let twitch = TwitchMock::start().await?;
        let process = process(&stores, &twitch, seeded(4))?;
        let rendered = process
            .delivery
            .render("%(*a 1)%(**b 2)%(#c 3)[%(*a)][%(**b)][%(#c)]", input())
            .await?;
        // The run's memo holds what it wrote; nothing reached MongoDB; cache variables work.
        assert_eq!(rendered.text, "[][][3]");
        assert_eq!(
            stores
                .mongo
                .documents("astvariables")
                .count_documents(doc! {})
                .await?,
            0
        );
        Ok(())
    }))
}

#[test]
fn cache_variables_live_a_day_under_the_reference_keys() -> Result<()> {
    run(with_stores(|stores| async move {
        insert_user(&stores, CHANNEL, "streamer", "free").await?;
        let twitch = TwitchMock::start().await?;
        let process = process(&stores, &twitch, seeded(5))?;
        process
            .delivery
            .render("%(#round 3)%(##hp 9)%(##hp(Rival) 4)", input())
            .await?;
        let dragonfly = &stores.dragonfly;
        for (key, value) in [
            ("twitch:1001:variable:round", "3"),
            ("twitch:1001:variable:hp:id:5001", "9"),
            ("twitch:1001:variable:hp:login:viewerone", "9"),
            ("twitch:1001:variable:hp:login:rival", "4"),
        ] {
            let key = stores.key(key);
            assert_eq!(
                dragonfly.get_text(&key).await?.as_deref(),
                Some(value),
                "{key}"
            );
            match dragonfly.ttl(&key).await? {
                Ttl::Seconds(seconds) => assert!((86_390..=86_400).contains(&seconds)),
                other => panic!("{key}: {other:?}"),
            }
        }
        let read = process
            .delivery
            .render("%(#round)/%(##hp)/%(##hp(rival))", input())
            .await?;
        assert_eq!(read.text, "3/9/4");
        Ok(())
    }))
}

#[test]
fn a_stored_value_too_long_is_refused() -> Result<()> {
    run(with_stores(|stores| async move {
        insert_user(&stores, CHANNEL, "streamer", "pro").await?;
        let twitch = TwitchMock::start().await?;
        let process = process(&stores, &twitch, seeded(6))?;
        // Over the host's bound: refused before it is transferred (the run stops).
        let huge = "x".repeat(1024 * 1024 + 1);
        stores
            .dragonfly
            .set(
                &stores.key("twitch:1001:variable:big"),
                huge.as_bytes(),
                Default::default(),
            )
            .await?;
        let failed = process.delivery.render("%(#big)", input()).await;
        assert!(
            matches!(&failed, Err(RenderError::Failed(message)) if message.contains("too long")),
            "{failed:?}"
        );
        // Under the host's bound but over the engine's text limit: the engine's own limit.
        let long = "y".repeat(300 * 1024);
        stores
            .dragonfly
            .set(
                &stores.key("twitch:1001:variable:long"),
                long.as_bytes(),
                Default::default(),
            )
            .await?;
        stores
            .mongo
            .documents("astvariables")
            .insert_one(doc! { "channelID": CHANNEL, "scopeType": "global", "scopeName": "global", "userId": "", "userLogin": "", "variables": { "long": long.as_str() } })
            .await?;
        let rendered = process
            .delivery
            .render("a%(#long)b%(*long)c", input())
            .await?;
        assert_eq!(
            rendered.text,
            "a[Parse error: This command builds text that is too long]b[Parse error: This command builds text that is too long]c"
        );
        Ok(())
    }))
}

fn chat_request(name: &str) -> CommandRequest {
    CommandRequest {
        channel_id: CHANNEL.into(),
        event_data: chat_event(),
        name: name.into(),
        argument: Some(String::new()),
        authorization: Some(ExecutionAuthorization {
            origin: ExecutionOrigin::Chat,
            identity: UserIdentity::new(1.0, [], Some("5001"), Some("viewerone")),
        }),
        reference: None,
        effect: None,
    }
}

/// `$(count)` run by two processes at once (the bot and the API): every increment is stored.
/// The reference stored each run's own total with `$set`, so concurrent runs lost increments.
#[test]
fn two_processes_racing_on_a_counter_lose_no_increment() -> Result<()> {
    run(with_stores(|stores| async move {
        insert_user(&stores, CHANNEL, "streamer", "premium").await?;
        insert_command(&stores, command_document(CHANNEL, "hola", "van $(count 1)")).await?;
        let twitch = TwitchMock::start().await?;
        let bot = process(&stores, &twitch, seeded(7))?;
        let api = process(&stores, &twitch, seeded(8))?;
        let per_process = 15;
        let runs = |p: &Process| {
            let delivery = std::sync::Arc::clone(&p.delivery);
            async move {
                let mut tasks = Vec::new();
                for _ in 0..per_process {
                    let delivery = std::sync::Arc::clone(&delivery);
                    tasks.push(tokio::spawn(async move {
                        delivery.command_handler(chat_request("hola")).await
                    }));
                }
                let mut ran = 0;
                for task in tasks {
                    if let CommandOutcome::Ran(_) = task.await.unwrap().unwrap() {
                        ran += 1;
                    }
                }
                ran
            }
        };
        let (a, b) = tokio::join!(runs(&bot), runs(&api));
        assert_eq!(a + b, 2 * per_process);
        let stored = stores
            .mongo
            .documents("commands")
            .find_one(doc! { "cmd": "hola" })
            .await?
            .unwrap();
        assert_eq!(stored.get("count"), Some(&Bson::Int32(2 * per_process)));
        Ok(())
    }))
}

/// Two processes writing different variables of a channel that has no document yet: both
/// upserts race on the unique index; the loser runs again and lands (the reference lost it).
#[test]
fn two_processes_creating_the_same_document_both_land() -> Result<()> {
    run(with_stores(|stores| async move {
        insert_user(&stores, CHANNEL, "streamer", "pro").await?;
        let twitch = TwitchMock::start().await?;
        // The unique indexes the reference creates at start-up.
        dima_model::ensure_indexes(
            &stores.mongo,
            &dima_model::ast_variables::INFO,
            dima_model::IndexPolicy::RequireAll,
            std::time::Duration::from_secs(30),
        )
        .await;
        let one = process(&stores, &twitch, seeded(9))?;
        let two = process(&stores, &twitch, seeded(10))?;
        for round in 0..20 {
            stores
                .mongo
                .documents("astvariables")
                .delete_many(doc! {})
                .await?;
            let (first, second) = (format!("%(*a{round} 1)"), format!("%(*b{round} 2)"));
            let (a, b) = tokio::join!(
                one.delivery.render(&first, input()),
                two.delivery.render(&second, input()),
            );
            a?;
            b?;
            let found = stores
                .mongo
                .documents("astvariables")
                .find_one(doc! { "userId": "" })
                .await?
                .unwrap();
            let names = found.get_document("variables")?;
            assert_eq!(names.len(), 2, "round {round}: {names:?}");
        }
        Ok(())
    }))
}

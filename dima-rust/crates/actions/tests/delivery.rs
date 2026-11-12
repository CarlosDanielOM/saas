//! Rendering, the two delivery semantics, and running commands with their references, against
//! the local stores and the Twitch mock: each rule of `ChatOut::send` and `ChatOut::deliver`,
//! the order of references, refusals (missing, disabled, cooldown, permission), the depth limit
//! and loops, one budget per message (fifty heavy references stop at the shared budget), and a
//! host call that never answers ending at the message's deadline.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod support;

use anyhow::Result;
use bson::doc;
use dima_actions::delivery::{AstMessage, RenderInput};
use dima_actions::host::DimaHost;
use dima_actions::runner::{
    CommandOutcome, CommandRequest, ExecutionAuthorization, ExecutionOrigin,
};
use dima_commands::permissions::UserIdentity;
use dima_core::{Clock, Random};
use dima_engine::context::{Context, Effect, Plan, State, TimerSnapshot};
use dima_engine::eval::{Engine, EvalError, EvalLimits, LimitKind, PerPlan};
use dima_engine::host::{Host, HostCall, HostError, HostFuture};
use dima_engine::registry::Registry;
use dima_engine::syntax::AstNode;
use dima_engine::value::Value;
use dima_store::dragonfly::Ttl;
use dima_twitch::chat::{ChatError, ChatOut, RenderScope, Rendering, Sent};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use support::*;

const CHANNEL: &str = "1001";

fn post(text: &str) -> Post {
    Post {
        channel: CHANNEL.into(),
        text: text.into(),
        reply_to: None,
    }
}

fn chat_event() -> serde_json::Map<String, serde_json::Value> {
    serde_json::json!({
        "broadcaster_user_id": CHANNEL,
        "chatter_user_id": "5001",
        "chatter_user_login": "viewerone",
        "chatter_user_name": "ViewerOne",
        "message_id": "chat-1",
    })
    .as_object()
    .cloned()
    .unwrap()
}

fn rendering(variables: &[(&str, &str)]) -> Rendering {
    Rendering {
        event_data: chat_event(),
        variables: variables
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect(),
        ..Rendering::default()
    }
}

async fn setup(stores: &Stores, commands: &[(&str, &str)]) -> Result<(TwitchMock, Process)> {
    insert_user(stores, CHANNEL, "streamer", "pro").await?;
    for (name, message) in commands {
        insert_command(stores, command_document(CHANNEL, name, message)).await?;
    }
    let twitch = TwitchMock::start().await?;
    let process = process(stores, &twitch, seeded(11))?;
    Ok((twitch, process))
}

#[test]
fn send_posts_what_it_rendered_untrimmed_as_a_reply_then_runs_the_references() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, process) = setup(&stores, &[("ref", "  from ref  ")]).await?;
        let scope = RenderScope::rendered(CHANNEL, rendering(&[("who", "Ana")])).replying_to("m-9");
        let sent = process
            .delivery
            .send(&scope, "  Hola %(who) #(ref) ")
            .await?;
        assert_eq!(
            sent,
            Sent::Posted {
                message_id: Some("msg-0".into())
            }
        );
        assert_eq!(
            twitch.posts(),
            [
                Post {
                    reply_to: Some("m-9".into()),
                    ..post("  Hola Ana  ")
                },
                post("from ref"),
            ]
        );
        assert!(twitch.unexpected().is_empty());
        Ok(())
    }))
}

#[test]
fn send_posts_the_text_unrendered_when_rendering_fails() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, process) = setup(&stores, &[("ref", "never")]).await?;
        // `$(ban)` belongs to a group that is not ported: the rendering throws.
        let scope = RenderScope::rendered(CHANNEL, rendering(&[]));
        let sent = process
            .delivery
            .send(&scope, "boom $(ban someone) #(ref)")
            .await?;
        assert_eq!(
            sent,
            Sent::Posted {
                message_id: Some("msg-0".into())
            }
        );
        assert_eq!(twitch.posts(), [post("boom $(ban someone) #(ref)")]);
        Ok(())
    }))
}

#[test]
fn send_never_posts_a_blank_text_and_still_runs_its_references() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, process) = setup(&stores, &[("ref", "only the reference")]).await?;
        let scope = RenderScope::rendered(CHANNEL, rendering(&[]));
        assert_eq!(
            process
                .delivery
                .send(&scope, "   %(nothing)  #(ref)  ")
                .await?,
            Sent::Nothing
        );
        assert_eq!(twitch.posts(), [post("only the reference")]);
        // A plain blank text posts nothing at all.
        assert_eq!(
            process
                .delivery
                .send(&RenderScope::plain(CHANNEL), " \t ")
                .await?,
            Sent::Nothing
        );
        assert_eq!(twitch.posts().len(), 1);
        // When the reference's post fails, that failure is the answer, with `type: 'error'`.
        twitch.set_reply(Reply::Held);
        let failed = process.delivery.send(&scope, " #(ref) ").await.unwrap_err();
        assert_eq!(failed.kind(), Some("error"));
        assert_eq!(
            failed.message(),
            Some("Message held for moderation review by Twitch")
        );
        Ok(())
    }))
}

#[test]
fn send_runs_no_reference_after_a_failed_post() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, process) = setup(&stores, &[("ref", "from ref")]).await?;
        twitch.set_reply(Reply::Denied);
        let scope = RenderScope::rendered(CHANNEL, rendering(&[]));
        let failed = process
            .delivery
            .send(&scope, "outer #(ref)")
            .await
            .unwrap_err();
        assert_eq!(
            failed,
            ChatError::Rejected {
                status: 403,
                kind: Some("Forbidden".into()),
                message: Some("denied".into())
            }
        );
        assert_eq!(twitch.posts(), [post("outer ")]);
        twitch.set_reply(Reply::Held);
        let held = process
            .delivery
            .send(&RenderScope::plain(CHANNEL), "x")
            .await
            .unwrap_err();
        assert_eq!(held.kind(), Some("held_for_moderation"));
        Ok(())
    }))
}

#[test]
fn deliver_fails_without_posting_when_rendering_fails() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, process) = setup(&stores, &[]).await?;
        let failed = process
            .delivery
            .deliver(CHANNEL, Some(&rendering(&[])), "text $(ban someone)")
            .await
            .unwrap_err();
        assert!(
            matches!(&failed, ChatError::Render { reason } if reason.contains("$(ban) is not ported yet")),
            "{failed:?}"
        );
        assert!(failed.is_thrown());
        assert!(twitch.posts().is_empty());
        Ok(())
    }))
}

#[test]
fn deliver_posts_trimmed_never_as_a_reply_in_order_and_stops_at_a_failed_post() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, process) = setup(
            &stores,
            &[
                ("a", " A1 #(c) "),
                ("b", "B1"),
                ("c", "C1"),
                ("off", "never"),
            ],
        )
        .await?;
        stores
            .mongo
            .documents("commands")
            .update_one(doc! { "cmd": "off" }, doc! { "$set": { "enabled": false } })
            .await?;
        process
            .delivery
            .deliver(
                CHANNEL,
                Some(&rendering(&[])),
                "  outer #(a) #(missing) #(off) #(b)  ",
            )
            .await?;
        // The outer text, then each reference in authored order, a reference's own references
        // before its next sibling; missing and disabled references are skipped.
        assert_eq!(
            twitch.posts(),
            [post("outer"), post("A1"), post("C1"), post("B1")]
        );
        // A plain delivery is posted as given (trimmed).
        process
            .delivery
            .deliver(CHANNEL, None, "  $(not rendered)  ")
            .await?;
        assert_eq!(twitch.posts().last(), Some(&post("$(not rendered)")));
        // A failed post stops the delivery: no reference runs.
        twitch.set_reply(Reply::Denied);
        let before = twitch.posts().len();
        let failed = process
            .delivery
            .deliver(CHANNEL, Some(&rendering(&[])), "outer #(b)")
            .await
            .unwrap_err();
        assert_eq!(failed.status(), Some(403));
        assert_eq!(twitch.posts().len(), before + 1);
        Ok(())
    }))
}

fn chat(name: &str, level: f64) -> CommandRequest {
    CommandRequest {
        channel_id: CHANNEL.into(),
        event_data: Value::from(serde_json::Value::Object(chat_event())),
        name: name.into(),
        argument: Some("uno dos".into()),
        authorization: Some(ExecutionAuthorization {
            origin: ExecutionOrigin::Chat,
            identity: UserIdentity::new(level, [], Some("5001"), Some("viewerone")),
        }),
        reference: None,
        effect: None,
    }
}

#[test]
fn commands_are_refused_as_the_reference_refuses_them() -> Result<()> {
    run(with_stores(|stores| async move {
        let (_twitch, process) = setup(&stores, &[("hola", "Hola &p1 y &t")]).await?;
        let mut cooled = command_document(CHANNEL, "slow", "slow");
        cooled.insert("cooldown", 30);
        insert_command(&stores, cooled).await?;
        let mut modonly = command_document(CHANNEL, "mods", "mods");
        modonly.insert("userLevel", 7);
        insert_command(&stores, modonly).await?;

        let CommandOutcome::Ran(ran) = process.delivery.command_handler(chat("hola", 1.0)).await?
        else {
            panic!("ran")
        };
        // Arguments are literal: a viewer's text is never parsed as command language.
        assert_eq!(ran.message, "Hola uno y dos");
        let refused = |outcome: CommandOutcome| match outcome {
            CommandOutcome::Refused(refused) => (refused.status, refused.kind),
            CommandOutcome::Ran(ran) => panic!("ran: {}", ran.message),
        };
        assert_eq!(
            refused(process.delivery.command_handler(chat("nope", 1.0)).await?),
            (400, "command_not_found")
        );
        // Names are looked up byte for byte.
        assert_eq!(
            refused(process.delivery.command_handler(chat("HOLA", 1.0)).await?),
            (400, "command_not_found")
        );
        assert!(matches!(
            process.delivery.command_handler(chat("slow", 1.0)).await?,
            CommandOutcome::Ran(_)
        ));
        assert_eq!(
            refused(process.delivery.command_handler(chat("slow", 1.0)).await?),
            (429, "command_cooldown")
        );
        let key = stores.key("command:execution:cooldown:1001:slow");
        assert_eq!(stores.dragonfly.get_text(&key).await?.as_deref(), Some("1"));
        assert!(matches!(
            stores.dragonfly.ttl(&key).await?,
            Ttl::Seconds(29..=30)
        ));
        assert_eq!(
            refused(process.delivery.command_handler(chat("mods", 1.0)).await?),
            (403, "permission_denied")
        );
        assert!(matches!(
            process.delivery.command_handler(chat("mods", 7.0)).await?,
            CommandOutcome::Ran(_)
        ));
        let mut unauthorized = chat("hola", 10.0);
        unauthorized.authorization = None;
        assert_eq!(
            refused(process.delivery.command_handler(unauthorized).await?),
            (403, "permission_denied")
        );
        stores
            .mongo
            .documents("commands")
            .update_one(
                doc! { "cmd": "hola" },
                doc! { "$set": { "enabled": false } },
            )
            .await?;
        process.deps.commands.invalidate_channel(CHANNEL).await?;
        assert_eq!(
            refused(process.delivery.command_handler(chat("hola", 1.0)).await?),
            (400, "command_disabled")
        );
        Ok(())
    }))
}

#[test]
fn references_stop_at_depth_five_and_never_loop() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, process) = setup(
            &stores,
            &[
                ("c1", "c1 #(c2)"),
                ("c2", "c2 #(c3)"),
                ("c3", "c3 #(c4)"),
                ("c4", "c4 #(c5)"),
                ("c5", "c5 #(c6)"),
                ("c6", "c6 #(c7)"),
                ("c7", "c7"),
                ("a", "A #(b) #(a)"),
                ("b", "B #(a)"),
            ],
        )
        .await?;
        let deliver = |name: &'static str| {
            let delivery = Arc::clone(&process.delivery);
            async move {
                let CommandOutcome::Ran(ran) = delivery.command_handler(chat(name, 1.0)).await?
                else {
                    panic!("ran")
                };
                delivery
                    .deliver_message(
                        CHANNEL,
                        AstMessage {
                            text: ran.message,
                            references: ran.references,
                        },
                        true,
                    )
                    .await?;
                anyhow::Ok(())
            }
        };
        deliver("c1").await?;
        let texts: Vec<String> = twitch.posts().into_iter().map(|p| p.text).collect();
        assert_eq!(texts, ["c1", "c2", "c3", "c4", "c5", "c6"]);
        deliver("a").await?;
        let texts: Vec<String> = twitch.posts().into_iter().skip(6).map(|p| p.text).collect();
        assert_eq!(texts, ["A", "B"]);
        Ok(())
    }))
}

#[test]
fn chat_off_runs_the_references_without_posting() -> Result<()> {
    run(with_stores(|stores| async move {
        let (twitch, process) = setup(&stores, &[("ref", "%(#ran yes)posted?")]).await?;
        let output = process
            .delivery
            .render(
                "outer #(ref)",
                RenderInput {
                    event_data: Value::from(serde_json::Value::Object(chat_event())),
                    ..RenderInput::new(CHANNEL)
                },
            )
            .await?;
        process
            .delivery
            .deliver_message(CHANNEL, output.into(), false)
            .await?;
        assert!(twitch.posts().is_empty());
        let key = stores.key("twitch:1001:variable:ran");
        assert_eq!(
            stores.dragonfly.get_text(&key).await?.as_deref(),
            Some("yes")
        );
        Ok(())
    }))
}

/// Fifty references to a heavy command: each would fit its own run, but the message's budget
/// (twice a run's) holds two of them; the third stops midway with the limit shown, and the
/// other forty-seven are refused.
#[test]
fn fifty_heavy_references_stop_at_the_shared_budget() -> Result<()> {
    run(with_stores(|stores| async move {
        // 40 iterations of a cache write: 80 host calls a run.
        let heavy = "*(for #i = 0; #i < 40; #i++ { %(#x #i) })heavy done";
        let limits = EvalLimits {
            host_calls: PerPlan::all(119),
            message_factor: 2,
            ..EvalLimits::default()
        };
        let engine = Engine::new(Registry::standard(), Default::default()).with_limits(limits);
        insert_user(&stores, CHANNEL, "streamer", "pro").await?;
        insert_command(&stores, command_document(CHANNEL, "heavy", heavy)).await?;
        let top = vec!["#(heavy)"; 50].join(" ");
        insert_command(&stores, command_document(CHANNEL, "top", &top)).await?;
        let twitch = TwitchMock::start().await?;
        let process = process_with(&stores, &twitch, seeded(12), engine)?;
        let CommandOutcome::Ran(ran) = process.delivery.command_handler(chat("top", 1.0)).await?
        else {
            panic!("ran")
        };
        assert_eq!(ran.references.len(), 50);
        process
            .delivery
            .deliver_message(
                CHANNEL,
                AstMessage {
                    text: ran.message,
                    references: ran.references,
                },
                true,
            )
            .await?;
        let texts: Vec<String> = twitch.posts().into_iter().map(|p| p.text).collect();
        assert_eq!(texts.len(), 3, "{texts:?}");
        assert_eq!(texts[0], "heavy done");
        assert_eq!(texts[1], "heavy done");
        assert!(
            texts[2].contains(&format!(
                "[Parse error: {}]",
                LimitKind::HostCalls.message()
            )),
            "{}",
            texts[2]
        );
        Ok(())
    }))
}

/// A host whose function calls never answer, over a real `DimaHost` for everything else: the
/// engine's race against `DimaHost::alarm` ends the call at the message's deadline, and the
/// call's future is dropped.
struct Silent {
    inner: DimaHost,
    dropped: Arc<AtomicBool>,
}

struct Guard(Arc<AtomicBool>);

impl Drop for Guard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl Host for Silent {
    fn clock(&self) -> &dyn Clock {
        self.inner.clock()
    }
    fn random(&self) -> &dyn Random {
        self.inner.random()
    }
    fn call<'a>(&'a mut self, _call: HostCall<'a>) -> HostFuture<'a, Result<Value, HostError>> {
        let guard = Guard(Arc::clone(&self.dropped));
        Box::pin(async move {
            let _guard = guard;
            std::future::pending::<()>().await;
            Ok(Value::empty())
        })
    }
    fn alarm(&self, millis: u64) -> HostFuture<'static, ()> {
        self.inner.alarm(millis)
    }
    fn sleep(&mut self, millis: u64) -> HostFuture<'_, ()> {
        self.inner.sleep(millis)
    }
    fn cache_get<'a>(
        &'a mut self,
        key: &'a str,
    ) -> HostFuture<'a, Result<Option<String>, HostError>> {
        self.inner.cache_get(key)
    }
    fn cache_exists<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<bool, HostError>> {
        self.inner.cache_exists(key)
    }
    fn cache_set<'a>(
        &'a mut self,
        key: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.inner.cache_set(key, value)
    }
    fn cache_expire<'a>(
        &'a mut self,
        key: &'a str,
        seconds: u64,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.inner.cache_expire(key, seconds)
    }
    fn cache_delete<'a>(&'a mut self, key: &'a str) -> HostFuture<'a, Result<(), HostError>> {
        self.inner.cache_delete(key)
    }
    fn load_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<String, HostError>> {
        self.inner.load_channel_variable(name)
    }
    fn save_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.inner.save_channel_variable(name, value)
    }
    fn delete_channel_variable<'a>(
        &'a mut self,
        name: &'a str,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.inner.delete_channel_variable(name)
    }
    fn load_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<String, HostError>> {
        self.inner.load_user_variable(name, target)
    }
    fn save_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        value: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.inner.save_user_variable(name, value, target)
    }
    fn delete_user_variable<'a>(
        &'a mut self,
        name: &'a str,
        target: Option<&'a str>,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.inner.delete_user_variable(name, target)
    }
    fn save_responses<'a>(
        &'a mut self,
        responses: &'a [String],
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.inner.save_responses(responses)
    }
    fn schedule_timer<'a>(
        &'a mut self,
        seconds: f64,
        body: &'a [AstNode],
        snapshot: TimerSnapshot,
    ) -> HostFuture<'a, Result<(), HostError>> {
        self.inner.schedule_timer(seconds, body, snapshot)
    }
    fn fork_effect(&mut self, effect: &Effect) -> Option<Effect> {
        self.inner.fork_effect(effect)
    }
}

#[test]
fn a_host_call_that_never_answers_ends_at_the_deadline() -> Result<()> {
    run(with_stores(|stores| async move {
        let twitch = TwitchMock::start().await?;
        let process = process(&stores, &twitch, seeded(13))?;
        let engine =
            Engine::new(Registry::standard(), Default::default()).with_limits(EvalLimits {
                deadline_ms: PerPlan::all(300),
                ..EvalLimits::default()
            });
        let dropped = Arc::new(AtomicBool::new(false));
        let mut host = Silent {
            inner: DimaHost::new(Arc::clone(&process.deps)),
            dropped: Arc::clone(&dropped),
        };
        let context = Context {
            broadcaster_id: CHANNEL.into(),
            user_plan: Plan::Pro,
            enforce_function_permissions: false,
            ..Context::default()
        };
        let program = engine.parse("$(twitch.title)")?;
        let started = tokio::time::Instant::now();
        // A generous outer bound only guards the test itself against a hang.
        let outcome = tokio::time::timeout(
            Duration::from_secs(30),
            engine.evaluate_program_message(&program, &context, State::default(), &mut host),
        )
        .await
        .expect("the evaluation ended");
        assert_eq!(outcome.unwrap_err(), EvalError::Limit(LimitKind::Deadline));
        assert!(started.elapsed() >= Duration::from_millis(300));
        assert!(
            dropped.load(Ordering::SeqCst),
            "the call's future was dropped"
        );
        Ok(())
    }))
}

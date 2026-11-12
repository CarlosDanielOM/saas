//! `simulate.test.ts`, the engine's half: a test run ([`Context::simulation`]) asks the host
//! about every function first, never evaluates a timer, and keeps pure functions real. The
//! command tester itself (argument placeholders, sample values, problem detection) is
//! `simulate.ts` and moves with the special parser to `dima-actions`; the cases that need
//! `&p1`/`&t` placeholders are left to it.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;

use dima_engine::context::{Context, Plan, State};
use dima_engine::value::Value;
use memory::{MemoryHost, engine_with, render};

/// `PURE_FUNCTIONS` of `simulate.ts`: they run for real in a test run.
const PURE: [&str; 16] = [
    "upper",
    "lower",
    "title",
    "capitalize",
    "trim",
    "length",
    "slice",
    "replace",
    "random",
    "user",
    "touser",
    "count",
    "scount",
    "bits",
    "break",
    "continue",
];

fn tester(seed: u64) -> MemoryHost {
    let mut host = MemoryHost::new(seed)
        .answer("twitch.game", |_, _| Value::text("Just Chatting"))
        .answer("twitch.viewers", |_, _| Value::text("42"));
    host.simulate_except = Some(PURE.to_vec());
    host
}

fn run_as(display: &str, plan: Plan, level: f64) -> Context {
    let login = display.to_lowercase();
    Context {
        broadcaster_id: "test-channel".into(),
        user_id: format!("test-{login}"),
        user_login: login,
        user_display_name: display.into(),
        user_plan: plan,
        user_level: level,
        enforce_function_permissions: false,
        simulation: true,
        ..Context::default()
    }
}

/// The tester's reply: rendered text with escapes undone and whitespace collapsed.
fn reply(text: &str) -> String {
    let text = dima_engine::syntax::unescape_rendered_text(text);
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn russian_roulette_real_randomness_timeouts_recorded_for_the_player_only() {
    let engine = engine_with(&[]);
    let body = "%(roll $(random 6)) *(%(roll) == 0 ? $(ban $(user) 60) : \"\") *(%(roll) == 0 ? \"${$(user)} died!\" : \"${$(user)} survived!\")";
    let (mut died, mut survived) = (0, 0);
    for seed in 0..50 {
        let mut host = tester(seed);
        let done = render(
            &engine,
            body,
            &run_as("Sam", Plan::Premium, 1.0),
            State::default(),
            &mut host,
        );
        match reply(&done.text).as_str() {
            "Sam died!" => {
                died += 1;
                assert_eq!(
                    host.recorded.calls,
                    [("ban".to_owned(), vec!["Sam".to_owned(), "60".to_owned()])]
                );
            }
            "Sam survived!" => {
                survived += 1;
                assert!(host.recorded.calls.is_empty());
            }
            other => panic!("{other}"),
        }
    }
    assert!(died > 0 && survived > 0 && died < 25, "{died} {survived}");
}

#[test]
fn per_viewer_counter_cache_variables_persist_across_runs_for_the_same_viewer_only() {
    let engine = engine_with(&[]);
    let body = "%(##hicount *(%(##hicount) + 1)) You have said hi %(##hicount) *(%(##hicount) == 1 ? \"time\" : \"times\")!";
    let mut host = tester(1);
    let replies: Vec<String> = ["Sam", "Sam", "Alex"]
        .iter()
        .map(|user| {
            reply(
                &render(
                    &engine,
                    body,
                    &run_as(user, Plan::Premium, 1.0),
                    State::default(),
                    &mut host,
                )
                .text,
            )
        })
        .collect();
    assert_eq!(
        replies,
        [
            "You have said hi 1 time!",
            "You have said hi 2 times!",
            "You have said hi 1 time!"
        ]
    );
}

#[test]
fn database_variables_follow_plan_rules_free_cannot_write_them() {
    let engine = engine_with(&[]);
    let body = "%(**voice gojo) saved %(**voice)";
    let premium = render(
        &engine,
        body,
        &run_as("Sam", Plan::Premium, 1.0),
        State::default(),
        &mut tester(1),
    );
    let free = render(
        &engine,
        body,
        &run_as("Sam", Plan::Free, 1.0),
        State::default(),
        &mut tester(1),
    );
    assert_eq!(reply(&premium.text), "saved gojo");
    assert_ne!(reply(&free.text), "saved gojo");
}

#[test]
fn reads_use_sample_values_actions_are_recorded_timers_and_delays_never_run() {
    let engine = engine_with(&[]);
    let body = "Playing $(twitch.game) for $(twitch.viewers). $(chat.send \"hi chat\") $(trigger.send airhorn) $(delay 30) $(timer 60 $(chat.send later)) $(set.title \"New title\")";
    let mut host = tester(1);
    let done = render(
        &engine,
        body,
        &run_as("Sam", Plan::Premium, 7.0),
        State::default(),
        &mut host,
    );
    assert_eq!(reply(&done.text), "Playing Just Chatting for 42.");
    let names: Vec<&str> = host
        .recorded
        .calls
        .iter()
        .map(|(name, _)| name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "twitch.game",
            "twitch.viewers",
            "chat.send",
            "trigger.send",
            "delay",
            "timer",
            "set.title"
        ]
    );
    assert_eq!(host.recorded.calls[6].1, ["New title"]);
    assert_eq!(
        host.recorded.calls[5].1,
        Vec::<String>::new(),
        "a timer is asked with no arguments"
    );
    assert!(host.recorded.sleeps.is_empty() && host.recorded.timers.is_empty());
}

#[test]
fn command_references_are_reported_not_run_the_use_count_is_tracked() {
    let engine = engine_with(&[]);
    let mut host = tester(1);
    let mut count = 0.0;
    let mut replies = Vec::new();
    for _ in 0..2 {
        let state = State {
            count,
            ..State::default()
        };
        let done = render(
            &engine,
            "Uses: $(count 1) #(socials)",
            &run_as("Sam", Plan::Premium, 1.0),
            state,
            &mut host,
        );
        count = done.state.count;
        replies.push(reply(&done.text));
        assert_eq!(done.state.command_references[0].command_name, "socials");
    }
    assert_eq!(replies, ["Uses: 1", "Uses: 2"]);
    assert_eq!(count, 2.0);
}

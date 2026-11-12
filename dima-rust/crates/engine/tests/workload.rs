//! The supported workload (`dima_engine::eval::limits`): two nested loops of the plan's
//! iteration count with 50 statements in the inner body, each a read or a write of a variable,
//! completes for every plan and every storage; ten times that stops at a limit. Prints what the
//! workload and the worst command cost (debug build, in-memory host).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod memory;

use dima_engine::context::{Context, Plan, State};
use dima_engine::eval::{EvalLimits, EvalStats, LimitKind, SUPPORTED_STATEMENTS};
use memory::{MemoryHost, block_on, engine_with};
use std::time::{Duration, Instant};

const PLANS: [Plan; 3] = [Plan::Free, Plan::Premium, Plan::Pro];

/// Variable prefixes: memory, cache, viewer cache, database, viewer database.
const STORAGES: [&str; 5] = ["", "#", "##", "*", "**"];

/// Two nested loops of the plan's iterations; the inner body writes and reads `statements / 2`
/// variables of one storage.
fn workload(plan: Plan, storage: &str, statements: u64) -> String {
    let n = plan.max_loop_iterations();
    let body: Vec<String> = (0..statements)
        .map(|k| {
            let name = format!("{storage}v{}", k / 2);
            if k % 2 == 0 {
                format!("%({name} #j)")
            } else {
                format!("%({name})")
            }
        })
        .collect();
    format!(
        "*(for #i = 0; #i < {n}; #i++ {{ *(for #j = 0; #j < {n}; #j++ {{ {} }}) }}) done",
        body.join(" ")
    )
}

fn run(source: &str, plan: Plan, limits: EvalLimits) -> (String, EvalStats, Duration) {
    let engine = engine_with(&[]).with_limits(limits);
    let template = engine.compile(source).unwrap();
    let context = Context {
        user_plan: plan,
        user_id: "1".into(),
        user_login: "caller".into(),
        ..Context::default()
    };
    let mut host = MemoryHost::new(1);
    let started = Instant::now();
    let rendered =
        block_on(engine.render_message(&template, &context, State::default(), &mut host)).unwrap();
    (rendered.text, rendered.stats, started.elapsed())
}

fn limit_hit(text: &str) -> bool {
    [LimitKind::Steps, LimitKind::HostCalls]
        .iter()
        .any(|kind| text.contains(&format!("[Parse error: {}]", kind.message())))
}

#[test]
fn the_supported_workload_completes_and_ten_times_it_does_not() {
    let limits = EvalLimits::default();
    for plan in PLANS {
        let mut worst = EvalStats::default();
        for storage in STORAGES {
            let (text, stats, elapsed) =
                run(&workload(plan, storage, SUPPORTED_STATEMENTS), plan, limits);
            assert_eq!(text, " done", "{plan:?} {storage:?}: {text}");
            println!(
                "{plan:?} {storage:>2}: {} steps, {} host calls, {elapsed:?}",
                stats.steps, stats.host_calls
            );
            worst.steps = worst.steps.max(stats.steps);
            worst.host_calls = worst.host_calls.max(stats.host_calls);
            let (text, _, _) = run(
                &workload(plan, storage, 10 * SUPPORTED_STATEMENTS),
                plan,
                limits,
            );
            assert!(
                limit_hit(&text),
                "{plan:?} {storage:?}: ten times completed"
            );
        }
        // The limits leave the workload room, and ten times the workload none.
        assert!(worst.steps <= limits.steps.of(plan), "{plan:?}");
        assert!(worst.host_calls <= limits.host_calls.of(plan), "{plan:?}");
        assert!(10 * worst.steps > limits.steps.of(plan), "{plan:?}");
        println!(
            "{plan:?} limits: {} steps, {} host calls",
            limits.steps.of(plan),
            limits.host_calls.of(plan)
        );
    }
}

/// What one command can cost at most: the plan's deepest loops around 400 statements (the
/// stored-command limit allows that many) spend all the work it allows, or all its host calls.
#[test]
fn the_worst_command_is_bounded() {
    let limits = EvalLimits::default();
    for plan in PLANS {
        let depth = plan.max_loop_depth() as usize;
        let n = plan.max_loop_iterations();
        let nest = |body: &str| {
            let mut text = body.to_owned();
            for level in 0..depth {
                text = format!("*(for #l{level} = 0; #l{level} < {n}; #l{level}++ {{ {text} }})");
            }
            text
        };
        let (text, stats, elapsed) = run(&nest(&"*(1 + 1) ".repeat(400)), plan, limits);
        assert!(limit_hit(&text), "{plan:?}: {text}");
        println!("{plan:?} worst work: {} steps, {elapsed:?}", stats.steps);
        let (text, stats, elapsed) = run(&nest(&"%(##x #l0) ".repeat(400)), plan, limits);
        assert!(limit_hit(&text), "{plan:?}: {text}");
        println!(
            "{plan:?} worst host calls: {} calls, {} steps, {elapsed:?}",
            stats.host_calls, stats.steps
        );
    }
}

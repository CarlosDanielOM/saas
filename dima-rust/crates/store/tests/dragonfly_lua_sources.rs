//! Every embedded Lua script is the TypeScript template literal, byte for byte (charter data
//! rule 7). Reads the frozen reference under `dimabot/src`; needs no store.

use anyhow::{Context, Result, ensure};
use dima_store::dragonfly::Script;
use dima_store::dragonfly::cron_queue::{ENQUEUE_DEDUPLICATED_JOB, PUBLISH_DURABLE_CRON_JOB};
use dima_store::dragonfly::plan_cache_fence::{
    ACCEPT_PLAN_CREDITS, CHECK_PLAN_ACCOUNTS, INVALIDATE_PLAN, READ_PLAN_ACCOUNT, SYNC_CREDITS,
    WRITE_PLAN_ACCOUNT,
};
use std::path::PathBuf;

fn reference(path: &str) -> Result<String> {
    let full = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../dimabot/src")
        .join(path);
    std::fs::read_to_string(&full).with_context(|| format!("read {}", full.display()))
}

/// The text between the backticks of `const NAME = \`...\`;` (with or without `export`).
fn template_literal(source: &str, name: &str) -> Result<String> {
    let marker = format!("const {name} = `");
    let start = source
        .find(&marker)
        .with_context(|| format!("{name} not found"))?
        + marker.len();
    let rest = source.get(start..).context("slice")?;
    let end = rest
        .find("`;")
        .with_context(|| format!("{name} not terminated"))?;
    let text = rest.get(..end).context("slice")?;
    ensure!(
        !text.contains("${") && !text.contains('\\'),
        "{name} uses interpolation or escapes"
    );
    Ok(text.to_owned())
}

#[test]
fn embedded_scripts_are_the_typescript_text() -> Result<()> {
    let cases: [(&Script, &str); 7] = [
        (&WRITE_PLAN_ACCOUNT, "utils/plan_cache_fence.ts"),
        (&CHECK_PLAN_ACCOUNTS, "utils/plan_cache_fence.ts"),
        (&ACCEPT_PLAN_CREDITS, "utils/plan_cache_fence.ts"),
        (&INVALIDATE_PLAN, "domain_events/polar_billing_events.ts"),
        (&SYNC_CREDITS, "domain_events/polar_billing_events.ts"),
        (&ENQUEUE_DEDUPLICATED_JOB, "utils/cron_jobs_queue.ts"),
        (&PUBLISH_DURABLE_CRON_JOB, "utils/durable_cron_jobs.ts"),
    ];
    for (script, file) in cases {
        let expected = template_literal(&reference(file)?, script.name())?;
        ensure!(
            script.source() == expected,
            "{} differs from {file}",
            script.name()
        );
    }
    Ok(())
}

#[test]
fn the_rust_only_read_script_matches_the_old_port() -> Result<()> {
    let old = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/utils/plan_cache_fence.rs");
    let old = std::fs::read_to_string(old)?;
    let marker = "pub const READ_PLAN_ACCOUNT_SCRIPT: &str = r#\"";
    let start = old.find(marker).context("marker")? + marker.len();
    let rest = old.get(start..).context("slice")?;
    let end = rest.find("\"#;").context("end")?;
    ensure!(READ_PLAN_ACCOUNT.source() == rest.get(..end).context("slice")?);
    Ok(())
}

#[test]
fn every_embedded_script_has_bounded_loops() -> Result<()> {
    for script in [
        &WRITE_PLAN_ACCOUNT,
        &CHECK_PLAN_ACCOUNTS,
        &ACCEPT_PLAN_CREDITS,
        &INVALIDATE_PLAN,
        &SYNC_CREDITS,
        &READ_PLAN_ACCOUNT,
        &ENQUEUE_DEDUPLICATED_JOB,
        &PUBLISH_DURABLE_CRON_JOB,
    ] {
        script.check()?;
    }
    Ok(())
}

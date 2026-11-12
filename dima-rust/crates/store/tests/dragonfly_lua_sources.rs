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

/// Every Lua template literal in the reference (files under `dimabot/src`, tests excluded):
/// `(file, constant name, text)`. Literals with interpolation are skipped (not one script text).
fn reference_scripts() -> Result<Vec<(String, String, String)>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../dimabot/src");
    let mut pending = vec![root.clone()];
    let mut found = Vec::new();
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))? {
            let path = entry?.path();
            let name = path.to_string_lossy().into_owned();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if !name.ends_with(".ts") || name.ends_with(".test.ts") {
                continue;
            }
            let source = std::fs::read_to_string(&path)?;
            let mut rest = source.as_str();
            while let Some(at) = rest.find(" = `") {
                let before = rest.get(..at).unwrap_or_default();
                let constant = before
                    .rsplit(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .next()
                    .unwrap_or_default()
                    .to_owned();
                let body = rest.get(at + 4..).unwrap_or_default();
                let Some(end) = body.find('`') else { break };
                let text = body.get(..end).unwrap_or_default();
                if text.contains("redis.call") && !text.contains("${") {
                    let file = name
                        .rsplit_once("dimabot/src/")
                        .map_or(name.clone(), |(_, file)| file.to_owned());
                    found.push((file, constant, text.to_owned()));
                }
                rest = body.get(end + 1..).unwrap_or_default();
            }
        }
    }
    found.sort();
    Ok(found)
}

/// The loop check is a heuristic: this pins what it says about the reference's own scripts.
/// Every one passes except the AI usage backfill's reclaim script (`while true`), which the
/// package porting that worker ports with an explicit iteration cap (see `script.rs`).
#[test]
fn reference_scripts_pass_the_loop_check_except_the_reclaim_script() -> Result<()> {
    let scripts = reference_scripts()?;
    ensure!(scripts.len() >= 20, "found only {} scripts", scripts.len());
    let mut refused = Vec::new();
    for (file, constant, text) in scripts {
        let name: &'static str = Box::leak(constant.clone().into_boxed_str());
        let source: &'static str = Box::leak(text.into_boxed_str());
        if Script::new(name, source).check().is_err() {
            refused.push(format!("{file}:{constant}"));
        }
    }
    ensure!(
        refused == ["workers/ai_usage_backfill.worker.ts:RECLAIM_SCRIPT"],
        "{refused:?}"
    );
    Ok(())
}

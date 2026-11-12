#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used, clippy::panic)]
use dima_hoststats::parse as p;
use serde_json::{Value as V, json};
fn vectors(range: std::ops::Range<usize>) -> anyhow::Result<()> {
    let vectors: V = serde_json::from_str(include_str!("vectors.json"))?;
    for v in &p::array(&vectors)[range] {
        let a = &v["args"];
        let s = || a[0].as_str().unwrap();
        let got = match v["fn"].as_str().unwrap() {
            "parseCpuStat" => p::cpu(s()),
            "cpuBetween" => p::cpu_between(&a[0], &a[1]),
            "parseMeminfo" => p::mem(s()),
            "parseDiskstats" => p::disks(s()),
            "parseNetDev" => p::net(s()),
            "parsePressure" => p::pressure(s()),
            "rate" => p::rate(&a[0], &a[1], p::number(&a[2])),
            "selectContainers" => json!(p::select(
                &a[0],
                &p::array(&a[1])
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            )),
            "statsCounters" => p::counters(&a[0]),
            "containerView" => p::view(&a[0], &a[1], &a[2], &a[3], p::number(&a[4])),
            "parseDf" => p::df(&a[0], a[1].as_i64().unwrap()),
            _ => panic!("unknown vector"),
        };
        assert_eq!(
            dima_text::to_js_json(&got),
            dima_text::to_js_json(&v["result"]),
            "{}",
            v["fn"]
        );
    }
    Ok(())
}
#[test]
fn coercion_resets_unicode_and_nonfinite() {
    assert_eq!(p::number(&json!("")), 0.);
    assert!(p::number(&json!("wat")).is_nan());
    assert_eq!(p::rate(&json!(100), &json!(50), 10.), V::Null);
    assert_eq!(p::rate(&json!(100), &json!(300), 0.), V::Null);
    assert_eq!(p::load("")["running"], 0.);
    assert_eq!(p::uptime(""), 0.);
    let i = json!({"Config":{"Image":"😀e\u{301}مرحبا".repeat(100)}});
    let v = p::view(
        &json!({"name":"a","project":"p"}),
        &i,
        &V::Null,
        &V::Null,
        0.,
    );
    assert_eq!(v["image"].as_str().unwrap().chars().count(), 200);
}

#[test]
fn host_proc_parsers() -> anyhow::Result<()> {
    vectors(0..9)
}
#[test]
fn only_allowlisted_compose_projects_are_reported() -> anyhow::Result<()> {
    vectors(9..10)
}
#[test]
fn container_view_rates_limits_stopped_and_cache_excluded_memory() -> anyhow::Result<()> {
    vectors(10..13)
}
#[test]
fn df_summary_shared_layers_and_reclaimable_cache() -> anyhow::Result<()> {
    vectors(13..14)
}
#[test]
fn reference_filesystem_fixture() {
    assert_eq!(
        p::filesystem(100., 10., 40., 30., 10., 4.),
        json!({"diskTotal":1000.,"diskFree":300.,"diskUsed":600.,"inodesTotal":10.,"inodesUsed":6.})
    );
}

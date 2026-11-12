#![forbid(unsafe_code)]
use dima_analytics::batch::{percentile, summarize, validate};
use serde_json::{Value, json};
fn batch() -> Value {
    json!({"version":1,"id":"00000000-0000-0000-0000-000000000001","service":"bot","instance":"fixture","metrics":[{"at":10000000,"kind":"chat","name":"message","channel":"channel-a","outcome":"ok","count":100,"sum":1000,"max":10,"histogram":[0,0,100,0,0,0,0,0,0,0,0,0,0,0,0,0]}],"spans":[],"logs":[]})
}
#[test]
fn rejects_malformed_oversized_and_inconsistent_batches() {
    let b = batch();
    assert!(validate(&b, 10000000).is_ok());
    let mut bad = b.clone();
    bad["metrics"][0]["histogram"][0] = json!(1);
    assert!(validate(&bad, 10000000).is_err());
    let mut bad = b.clone();
    bad["metrics"][0]["at"] = json!(0);
    assert!(validate(&bad, 10000000).is_err());
    let mut bad = b;
    bad["spans"] = json!(vec![json!({}); 51]);
    assert!(validate(&bad, 10000000).is_err());
}
#[test]
fn percentiles_merge_counts_not_percentile_values() {
    let a = batch()["metrics"][0].clone();
    let mut b = a.clone();
    b["count"] = json!(1);
    b["histogram"] = json!([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    b["sum"] = json!(30000);
    b["max"] = json!(30000);
    let s = summarize(&[a, b]);
    assert_eq!(s["count"], 101.);
    assert_eq!(s["p95"], 10.);
    assert_eq!(s["p99"], 10.);
    assert_eq!(percentile(&[0.; 16], 0.95), Value::Null);
}
#[test]
fn filters_cannot_widen_an_access_grant() {
    let mut args = vec![];
    let sql = dima_analytics::service::scope(
        &json!({"channels":["allowed"],"services":["bot"]}),
        &json!({"channel":"other","service":"api"}),
        &mut args,
    );
    assert_eq!(args.len(), 4);
    assert_eq!(
        sql,
        " AND channel = ANY($1::text[]) AND channel = $2 AND service = ANY($3::text[]) AND service = $4"
    );
}
#[test]
fn unicode_limits_and_controls() {
    let mut b = batch();
    for text in ["😀".repeat(50), "e\u{301}".repeat(25), "مرحبا".repeat(10)] {
        b["service"] = json!(text);
        assert!(validate(&b, 10000000).is_ok());
    }
    b["service"] = json!("😀".repeat(51));
    assert!(validate(&b, 10000000).is_err());
    b["service"] = json!("bad\nname");
    assert!(validate(&b, 10000000).is_err());
}
#[test]
fn rust_producer_fixtures_validate() -> anyhow::Result<()> {
    for fixture in [
        include_str!("../../../crates/telemetry/tests/fixtures/analytics/0-api.json"),
        include_str!("../../../crates/telemetry/tests/fixtures/analytics/1-cron.json"),
    ] {
        let b: Value = serde_json::from_str(fixture)?;
        validate(
            &b,
            b["at"]
                .as_i64()
                .ok_or_else(|| anyhow::anyhow!("fixture timestamp"))?
                + 1000,
        )?;
    }
    Ok(())
}
#[test]
fn resource_parsers_allow_only_numeric_resource_fields() {
    assert_eq!(
        dima_analytics::collectors::parse_info("# Memory\r\nused_memory:123\r\n")["used_memory"],
        "123"
    );
    assert_eq!(
        dima_analytics::collectors::parse_openmetrics("memory_active_bytes 42\nsecret_metric 99"),
        json!({"memory_active_bytes":42.})
    );
}
#[test]
fn snapshot_sanitizer_removes_unknown_fields() -> anyhow::Result<()> {
    let raw = json!({"version":1,"at":"2026-11-11T12:00:00.000Z","secret":"private","host":{"cpuPct":20,"memUsed":"bad"},"containers":[{"name":"good","state":"running","secret":"token"},{"name":"bad space"}],"docker":{"reachable":true},"errors":["😀".repeat(121),5]});
    let v = dima_analytics::infrastructure::sanitize(&raw)?;
    assert!(v.get("secret").is_none());
    assert_eq!(v["host"]["cpuPct"], 20.);
    assert_eq!(v["host"]["memUsed"], Value::Null);
    assert_eq!(v["containers"].as_array().map(Vec::len), Some(1));
    assert!(!v.to_string().contains("token"));
    assert_eq!(
        v["errors"][0].as_str().map(|s| s.chars().count()),
        Some(120)
    );
    assert!(dima_analytics::infrastructure::sanitize(&json!({"version":2})).is_err());
    Ok(())
}

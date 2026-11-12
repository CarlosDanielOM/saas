//! Bounded telemetry edge validation. User text limits count Unicode scalar values (charter §4).
use crate::{Error, Result};
use serde_json::{Value, json};
pub const BOUNDS: [f64; 16] = [
    1., 5., 10., 25., 50., 100., 250., 500., 1000., 2500., 5000., 10000., 30000., 60000., 300000.,
    1e12,
];
fn text(v: &Value, max: usize) -> bool {
    v.as_str()
        .is_some_and(|s| s.chars().count() <= max && !s.chars().any(|c| c < ' '))
}
fn number(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n.is_finite() && (0. ..=1e15).contains(&n))
}
fn integer(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0. && (0. ..=9007199254740991.).contains(n))
}
pub fn hex(v: &Value, len: usize) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
pub fn validate(batch: &Value, now: i64) -> Result<()> {
    let id = batch["id"].as_str().unwrap_or("");
    if batch["version"].as_f64() != Some(1.)
        || id.len() != 36
        || !id
            .bytes()
            .all(|b| b == b'-' || b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !text(&batch["service"], 50)
        || !text(&batch["instance"], 100)
    {
        return Err(Error::Invalid("Invalid envelope"));
    }
    for (key, limit) in [("metrics", 100), ("spans", 50), ("logs", 25)] {
        if batch[key].as_array().is_none_or(|a| a.len() > limit) {
            return Err(Error::Invalid("Invalid batch size"));
        }
    }
    let valid_time = |v: &Value| {
        number(v)
            && v.as_f64()
                .is_some_and(|n| n >= (now - 3600000) as f64 && n <= (now + 60000) as f64)
    };
    for m in batch["metrics"].as_array().into_iter().flatten() {
        let count = integer(&m["count"]).filter(|n| (1. ..=1e8).contains(n));
        let hist = m["histogram"].as_array();
        if !valid_time(&m["at"])
            || !text(&m["kind"], 30)
            || !text(&m["name"], 100)
            || !text(&m["channel"], 80)
            || !text(&m["outcome"], 30)
            || count.is_none()
            || !number(&m["sum"])
            || !number(&m["max"])
            || hist.is_none_or(|h| {
                h.len() != 16
                    || h.iter().any(|v| integer(v).is_none())
                    || Some(h.iter().filter_map(integer).sum::<f64>()) != count
            })
        {
            return Err(Error::Invalid("Invalid metric"));
        }
    }
    for s in batch["spans"].as_array().into_iter().flatten() {
        if !valid_time(&s["at"])
            || !number(&s["duration"])
            || !hex(&s["traceId"], 32)
            || !hex(&s["spanId"], 16)
            || !(s.get("parentId") == Some(&Value::Null) || hex(&s["parentId"], 16))
            || !text(&s["channel"], 80)
            || !text(&s["kind"], 30)
            || !text(&s["name"], 100)
            || !text(&s["outcome"], 30)
        {
            return Err(Error::Invalid("Invalid span"));
        }
    }
    for l in batch["logs"].as_array().into_iter().flatten() {
        if !valid_time(&l["at"])
            || !matches!(l["level"].as_str(), Some("warn" | "error" | "fatal"))
            || !text(&l["name"], 100)
            || !text(&l["channel"], 80)
            || !(l.get("traceId") == Some(&Value::Null) || hex(&l["traceId"], 32))
            || !(l["fields"].is_object() || l["fields"].is_array())
            || dima_text::to_js_json(&l["fields"]).chars().count() > 2000
        {
            return Err(Error::Invalid("Invalid log"));
        }
    }
    Ok(())
}
pub fn percentile(histogram: &[f64], fraction: f64) -> Value {
    let total: f64 = histogram.iter().sum();
    if total == 0. {
        return Value::Null;
    }
    let mut count = 0.;
    for (i, n) in histogram.iter().enumerate() {
        count += n;
        if count >= total * fraction {
            return if BOUNDS[i] == 1e12 {
                Value::Null
            } else {
                json!(BOUNDS[i])
            };
        }
    }
    Value::Null
}
pub fn summarize(rows: &[Value]) -> Value {
    let (mut count, mut sum, mut max, mut errors) = (0., 0., 0_f64, 0.);
    let mut hist = [0.; 16];
    for r in rows {
        let n = |k: &str| r[k].as_f64().unwrap_or(0.);
        count += n("count");
        sum += n("sum");
        max = max.max(n("max"));
        if matches!(r["outcome"].as_str(), Some("error" | "aborted" | "failed")) {
            errors += n("count");
        }
        for (i, v) in r["histogram"]
            .as_array()
            .into_iter()
            .flatten()
            .take(16)
            .enumerate()
        {
            hist[i] += v.as_f64().unwrap_or(0.);
        }
    }
    json!({"count":count,"sum":sum,"max":max,"errors":errors,"histogram":hist,"average":if count>0.{json!(sum/count)}else{Value::Null},"p50":percentile(&hist,0.5),"p95":percentile(&hist,0.95),"p99":percentile(&hist,0.99)})
}

use dima_email::*;
use serde_json::Value;
#[test]
fn reference_templates() {
    let corpus: Value = serde_json::from_str(include_str!("golden.json")).unwrap();
    for (i, case) in corpus["cases"].as_array().unwrap().iter().enumerate() {
        let p = case["input"].clone();
        let email = match case["kind"].as_str().unwrap() {
            "welcome" => welcome(&serde_json::from_value(p).unwrap()),
            "activation-reminder" => activation_reminder(&serde_json::from_value(p).unwrap()),
            "stream-summary" => stream_summary(&serde_json::from_value(p).unwrap()),
            _ => clip_analysis_finished(&serde_json::from_value(p).unwrap()),
        }
        .unwrap();
        for (field, actual) in [
            ("html", email.html),
            ("text", email.text),
            ("subject", email.subject),
        ] {
            let expected = case[field].as_str().unwrap();
            if actual != expected {
                let mismatch = actual
                    .chars()
                    .zip(expected.chars())
                    .position(|(a, b)| a != b)
                    .unwrap_or(actual.chars().count().min(expected.chars().count()));
                panic!(
                    "case {i} {} {field} at {mismatch}: actual {:?} expected {:?}",
                    case["kind"],
                    actual
                        .chars()
                        .skip(mismatch.saturating_sub(50))
                        .take(180)
                        .collect::<String>(),
                    expected
                        .chars()
                        .skip(mismatch.saturating_sub(50))
                        .take(180)
                        .collect::<String>()
                );
            }
        }
    }
}

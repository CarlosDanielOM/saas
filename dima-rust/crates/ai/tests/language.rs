use dima_ai::language::Detector;
use serde_json::Value;
#[test]
fn stateful_reference_language_heuristic() -> anyhow::Result<()> {
    let cases: Vec<Value> = serde_json::from_str(include_str!("language_reference.json"))?;
    let mut detector = Detector::new()?;
    for c in cases {
        assert_eq!(
            detector.detect_language(c["text"].as_str().unwrap(), 0.1),
            c["expected"].as_str().unwrap()
        );
    }
    Ok(())
}

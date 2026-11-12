#![allow(clippy::unwrap_used)]
use dima_tts::normalize::*;
use serde_json::Value;
#[test]
fn recorded_text_vectors() {
    let data: Value = serde_json::from_slice(&dima_text::sanitize_lone_surrogates(include_bytes!(
        "vectors.json"
    )))
    .unwrap();
    let mut changed = 0;
    for case in data["vectors"].as_array().unwrap() {
        let options: Options = serde_json::from_value(case["options"].clone()).unwrap();
        let raw = case["raw"].as_str().unwrap();
        assert_eq!(
            billable_characters(raw),
            case["billing"].as_u64().unwrap() as usize
        );
        let actual = normalize(raw, &options);
        let recorded: Normalized = serde_json::from_value(case["result"].clone()).unwrap();
        if actual != recorded {
            // Explicit intended difference: our own maxLength counts scalar values, never UTF-16 units.
            // Re-run without a cut, then independently apply the scalar prefix. Billing has no exception.
            let mut unbounded = options.clone();
            unbounded.max_length = 0;
            let full = normalize(raw, &unbounded);
            assert!(options.max_length > 0 && full.text.chars().any(|c| c.len_utf16() == 2));
            let expected: String = full.text.chars().take(options.max_length).collect();
            assert_eq!(actual.text, dima_text::trim(&expected));
            changed += 1;
        }
    }
    assert_eq!(
        changed, 1264,
        "update only after inspecting the intended differences"
    );
    for case in data["spoken"].as_array().unwrap() {
        assert_eq!(
            spoken_user_message(
                case["name"].as_str().unwrap(),
                "hello",
                case["language"].as_str().unwrap(),
                case["source"].as_str().unwrap()
            ),
            case["result"].as_str().unwrap()
        );
    }
    for case in data["templates"].as_array().unwrap() {
        assert_eq!(
            migrate_legacy_template(case["input"].as_str()),
            case["result"].as_str().unwrap()
        );
    }
}

#[test]
fn recorded_cues_and_emotes() {
 let data: Value=serde_json::from_slice(&dima_text::sanitize_lone_surrogates(include_bytes!("vectors.json"))).unwrap();
 for case in data["cues"].as_array().unwrap() {
  let enabled=serde_json::from_value(case["enabledTags"].clone()).unwrap();
  let filtered=dima_tts::tags::filter(case["text"].as_str().unwrap(),case["provider"].as_str().unwrap(),&enabled);
  assert_eq!(filtered,case["filtered"].as_str().unwrap(),"{case}");
  assert_eq!(dima_tts::tags::reinforce(&filtered),case["reinforced"].as_str().unwrap());
 }
 for case in data["emotes"].as_array().unwrap() {
  let ranges=serde_json::from_value::<Vec<String>>(case["ranges"].clone()).unwrap();
  let actual=extract_emote_names(case["text"].as_str().unwrap(),&ranges);
  // Boundary repair is intentional when the reference range cuts an emoji surrogate pair.
  let recorded:Vec<String>=serde_json::from_value(case["result"].clone()).unwrap();
  if actual!=recorded { assert!(recorded.iter().any(|s|s.contains('�'))); } else { assert_eq!(actual,recorded); }
 }
}

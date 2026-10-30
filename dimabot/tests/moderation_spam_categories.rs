#![cfg(feature = "moderation-spam-categories")]

#[path = "support/moderation_leaf_source.rs"]
mod moderation_leaf_source;

use dima_rust::utils::moderation::spam_categories::*;

#[test]
fn closed_types_defaults_and_independent_copies() {
    assert_eq!(
        SPAM_CATEGORIES.map(SpamCategory::as_str),
        ["spam", "ads", "self_promotion", "profanity", "insults"]
    );
    assert_eq!(
        SPAM_EXEMPT_TAGS.map(SpamExemptTag::as_str),
        ["vip", "mod", "sub", "founder", "editor", "admin"]
    );
    assert_eq!(SpamCategory::parse("unsafe"), None);
    assert_eq!(SpamExemptTag::parse("unknown"), None);
    assert_eq!(DEFAULT_SPAM_THRESHOLD, 85.0);
    assert_eq!(SPAM_CLASSIFIER_MODEL, "typesafe/jev-1.13");
    let mut a = DEFAULT_SPAM_CATEGORIES.to_vec();
    let b = DEFAULT_SPAM_CATEGORIES.to_vec();
    a.push(SpamCategory::Spam);
    assert_eq!(b.len(), 3);
    let mut a = DEFAULT_SPAM_EXEMPT_TAGS.to_vec();
    let b = DEFAULT_SPAM_EXEMPT_TAGS.to_vec();
    a.clear();
    assert_eq!(b.len(), 3);
    let p = SpamProtection {
        enabled: true,
        review_all_messages: false,
        categories: None,
        threshold_percent: Some(85.5),
        exempt_tags: None,
    };
    assert_eq!(p.threshold_percent, Some(85.5));
}

#[test]
fn duplicate_order_and_invitation() {
    use SpamCategory::*;
    let q = category_questions(&[Ads, SelfPromotion, Ads], true);
    assert_eq!(
        q.questions.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
        vec![Ads, SelfPromotion]
    );
    assert_eq!(
        q.questions[1].1.true_criteria,
        INVITED_SELF_PROMOTION_POLICY
    );
    assert_eq!(q.unsafe_policy.matches(Ads.policy()).count(), 2);
    assert_eq!(
        category_questions(&[SelfPromotion], false).questions[0]
            .1
            .true_criteria,
        SelfPromotion.policy()
    );
    assert_eq!(category_questions(&[], false).questions.len(), 0);
}

#[test]
#[ignore = "requires externally generated pinned TypeScript oracle"]
fn replay_reference_full_wire() {
    moderation_leaf_source::path(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")),
        "src/utils/moderation/spam_categories.ts",
    );
    let file =
        std::env::var("DIMA_SPAM_CATEGORIES_REFERENCE").expect("absolute reference JSON path");
    assert!(std::path::Path::new(&file).is_absolute());
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(file).unwrap()).unwrap();
    let c = &data["metadata"]["constants"];
    assert_eq!(c["threshold"].as_f64().unwrap(), DEFAULT_SPAM_THRESHOLD);
    assert_eq!(c["model"].as_str().unwrap(), SPAM_CLASSIFIER_MODEL);
    for (i, category) in SPAM_CATEGORIES.iter().enumerate() {
        assert_eq!(c["categories"][i].as_str().unwrap(), category.as_str());
        assert_eq!(
            c["policies"][category.as_str()].as_str().unwrap(),
            category.policy()
        );
    }
    for (i, tag) in SPAM_EXEMPT_TAGS.iter().enumerate() {
        assert_eq!(c["tags"][i].as_str().unwrap(), tag.as_str());
    }
    for (i, category) in DEFAULT_SPAM_CATEGORIES.iter().enumerate() {
        assert_eq!(c["defaults"][i].as_str().unwrap(), category.as_str());
    }
    for (i, tag) in DEFAULT_SPAM_EXEMPT_TAGS.iter().enumerate() {
        assert_eq!(c["defaultTags"][i].as_str().unwrap(), tag.as_str());
    }
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 752);
    assert_eq!(data["metadata"]["total"].as_u64(), Some(752));
    assert_eq!(
        data["metadata"]["nodeSha"],
        "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
    );
    for case in cases {
        let categories: Vec<_> = case["categories"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| SpamCategory::parse(v.as_str().unwrap()).unwrap())
            .collect();
        assert_eq!(
            category_questions(&categories, case["invitation"].as_bool().unwrap()).to_json_string(),
            case["wire"].as_str().unwrap(),
            "{case}"
        );
    }
}

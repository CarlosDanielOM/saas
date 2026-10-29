#![cfg(feature = "ai-usage")]

use dima_rust::utils::ai_usage::{Category, normalize_receipt_category};

#[test]
fn receipt_categories_are_exact_closed_tokens() {
    let cases = [
        ("tts", Category::Tts),
        ("ai_chat", Category::AiChat),
        ("ai_agent", Category::AiAgent),
        ("memory", Category::Memory),
        ("clip_recommendation", Category::ClipRecommendation),
        ("credit_adjustment", Category::CreditAdjustment),
        ("other", Category::Other),
    ];
    for (token, expected) in cases {
        assert_eq!(Category::parse_token(token), Some(expected));
        assert_eq!(expected.as_str(), token);
        assert_eq!(normalize_receipt_category(Some(token)), token);
    }
    assert_eq!(normalize_receipt_category(None), "uncategorized");
    for token in [
        "uncategorized",
        "",
        "unknown",
        "TTS",
        " tts",
        "tts ",
        "tts\n",
        "tts\0",
        "mémoire",
        "me\u{301}mory",
        "K",
        "😀",
        "\u{fffd}",
    ] {
        assert_eq!(Category::parse_token(token), None, "{token:?}");
        assert_eq!(
            normalize_receipt_category(Some(token)),
            "uncategorized",
            "{token:?}"
        );
    }
}

#![cfg(feature = "ai-threading")]
use dima_rust::utils::ai_threading::{thread_limits::*, thread_store::extract_keywords, thread_router::*};
#[test]
fn tier_and_token_contracts() {
    for (tier,expected) in [(ThreadPlanTier::Pro,(250,12,120,100)),(ThreadPlanTier::Premium,(100,6,60,40)),(ThreadPlanTier::Free,(40,3,20,10))] {
        let l=get_thread_limits_for_tier(tier);
        assert_eq!((l.max_channel_threads,l.max_user_threads,l.max_turns_stored,l.prompt_turns),expected);
    }
    assert_eq!(ThreadPlanTier::from_value("unknown"),ThreadPlanTier::Free);
    assert_eq!(extract_keywords("The wow fox fox and niño 12 gato"),vec!["fox","niño","gato"]);
    assert_eq!(extract_keywords(&(0..20).map(|n|format!("word{n}")).collect::<Vec<_>>().join(" ")).len(),12);
    assert_eq!(tokenize("domdimabot hi fox"),vec!["fox"]);
    assert_eq!(tokenize(&"word ".repeat(80)).len(),64);
}
#[test]
fn scores_follow_source_weights() {
    assert_eq!(lexical_similarity(&[],&[]),0.0);
    assert_eq!(lexical_similarity(&["one".into(),"two".into()],&["two".into()]),0.5);
    assert_eq!(recency_score(2000,1000),1.0);
    assert_eq!(recency_score(0,86_400_000),0.0);
    assert!((combined_score(1.0,1.0,true)-1.0).abs()<1e-12);
}
#[test]
fn pinned_unicode_categories_and_lowercasing() {
    assert_eq!(tokenize("İSTANBUL KELVIN"),vec!["stanbul","kelvin"]);
    assert_eq!(extract_keywords("𐐀𐐀𐐀 １２３"),vec!["𐐨𐐨𐐨","１２３"]);
}
#[test]
fn sticky_selection_and_utc_bucket() {
    use dima_rust::utils::ai_threading::thread_types::{ThreadMeta,ThreadStatus};
    let meta=ThreadMeta {thread_id:"t".into(),channel_id:"c".into(),owner_user_id:"u".into(),owner_username:"name".into(),created_at:String::new(),updated_at:String::new(),last_activity_ts:1000,status:ThreadStatus::Active,topic_seed:"".into(),topic_keywords:vec![],message_count:0,last_user_message:None,last_assistant_message:None};
    assert!(sticky(&meta,1000+STICKY_THREAD_WINDOW_MS));
    assert!(!sticky(&meta,1001+STICKY_THREAD_WINDOW_MS));
    assert!(should_create_thread(true,0.349));
    assert!(!should_create_thread(true,0.35));
    assert!(should_create_thread(false,1.0));
    assert_eq!(format_minute_bucket(0).unwrap(),"197001010000");
    assert_eq!(format_minute_bucket(946_691_100_000).unwrap(),"200001010145");
}
#[test]
fn utf16_seed_and_corrupt_payloads() {
    use dima_rust::utils::{js_string::JsString,ai_threading::{thread_store::{parse_thread_meta,parse_thread_turns},thread_types::{ThreadMeta,ThreadStatus}}};
    let seed=format!("{}😀","a".repeat(219));
    let seed=JsString::from_units(seed.encode_utf16().collect()).slice(0,220);
    let meta=ThreadMeta {thread_id:"t".into(),channel_id:"c".into(),owner_user_id:"u".into(),owner_username:"n".into(),created_at:"x".into(),updated_at:"x".into(),last_activity_ts:1,status:ThreadStatus::Active,topic_seed:seed.clone(),topic_keywords:vec![],message_count:0,last_user_message:None,last_assistant_message:None};
    let json=serde_json::to_string(&meta).unwrap();
    assert!(json.contains(r"\ud83d")); assert!(!json.contains('�'));
    assert_eq!(parse_thread_meta(&json).unwrap().topic_seed,seed);
    assert!(parse_thread_meta("{broken").is_none());
    let turns=parse_thread_turns(vec![r#"{"role":"assistant","message":"two","timestamp":2}"#.into(),"not json".into(),r#"{"role":"user","message":"one","timestamp":1}"#.into()]);
    assert_eq!(turns.iter().map(|t|t.message.as_str()).collect::<Vec<_>>(),vec!["one","two"]);
    assert_eq!(tokenize("alpha\u{feff}bravo"),vec!["alpha","bravo"]);
    assert_eq!(extract_keywords("alpha\u{feff}bravo"),vec!["alpha","bravo"]);
}
#[test]
fn thread_json_field_names() {
    use dima_rust::utils::ai_threading::thread_types::{ThreadTurn,ThreadRole};
    let turn=ThreadTurn {role:ThreadRole::User,user_id:Some("7".into()),username:None,message:"hello".into(),timestamp:1,source_message_id:Some("m".into()),delivered:None};
    let json=serde_json::to_value(turn).unwrap();
    assert_eq!(json["userID"],"7"); assert_eq!(json["sourceMessageId"],"m");
    assert!(json.get("user_id").is_none()); assert!(json.get("delivered").is_none());
}

#![cfg(feature = "channel-ai-personality")]
use dima_rust::{schemas::channel_ai_personality::{apply_save_rules,ensure_profiles,prepare_personality_validation},utils::credit_policy::JsDate};
use mongodb::bson::{doc, Bson, DateTime};
fn profile(id:&str)->Bson { Bson::Document(doc! {"profileID":id,"personality":"hello","personaMode":"original"}) }
#[test]
fn fallback_projection_and_limits() {
    let mut d=doc! {}; ensure_profiles(&mut d).unwrap();
    assert_eq!(d.get_array("profiles").unwrap().len(),1);
    assert_eq!(d.get_document("voiceProfile").unwrap().get_str("tone").unwrap(),"friendly and playful");
    for (tier,limit,window) in [("free",1,7),("premium",2,15),("pro",3,35)] {
        let profiles=(0..limit).map(|n|profile(&n.to_string())).collect::<Vec<_>>();
        let mut d=doc! {"profiles":profiles,"rules":[],"knownUsers":[]};
        apply_save_rules(&mut d,tier,JsDate::from_millis(1234.0)).unwrap();
        assert_eq!(d.get_i32("contextWindow").unwrap(),window);
        let p=d.get_array("profiles").unwrap()[0].as_document().unwrap();
        assert_eq!(p.get_datetime("createdAt").unwrap(),&DateTime::from_millis(1234));
        d.get_array_mut("profiles").unwrap().push(profile("extra"));
        let expected=format!("Current plan allows up to {limit} personality profile{}",if limit>1 {"s"} else {""});
        assert_eq!(apply_save_rules(&mut d,tier,JsDate::from_millis(1234.0)).unwrap_err().to_string(),expected);
    }
}
#[test]
fn caps_and_existing_profile_timestamps() {
    let now=JsDate::from_millis(5000.0);
    for (tier,rules_cap,user_cap) in [("free",3,3),("premium",5,10)] {
        let rules=vec![Bson::String("rule".into());rules_cap];
        let users=vec![Bson::Document(doc! {});user_cap];
        let mut d=doc! {"profiles":[{"profileID":"p","personality":"yes","personaMode":"original","createdAt":DateTime::from_millis(1000),"updatedAt":DateTime::from_millis(2000)}],"activeProfileId":"missing","rules":rules,"knownUsers":users};
        apply_save_rules(&mut d,tier,now).unwrap();
        assert_eq!(d.get_str("activeProfileId").unwrap(),"p");
        let p=d.get_array("profiles").unwrap()[0].as_document().unwrap();
        assert_eq!(p.get_datetime("createdAt").unwrap(),&DateTime::from_millis(1000));
        assert_eq!(p.get_datetime("updatedAt").unwrap(),&DateTime::from_millis(5000));
        d.get_array_mut("rules").unwrap().push(Bson::String("extra".into()));
        let label=if tier=="free" {"Free"} else {"Premium"};
        assert_eq!(apply_save_rules(&mut d,tier,now).unwrap_err().to_string(),format!("{label} channels can only have up to {rules_cap} rules"));
        d.get_array_mut("rules").unwrap().pop();
        d.get_array_mut("knownUsers").unwrap().push(Bson::Document(doc! {}));
        assert_eq!(apply_save_rules(&mut d,tier,now).unwrap_err().to_string(),format!("{label} channels can only have up to {user_cap} known users"));
    }
}
#[test]
fn legacy_projection_fills_all_voice_defaults() {
    let mut d=doc! {"profiles":[],"activeProfileId":"stale","personality":"custom"};
    ensure_profiles(&mut d).unwrap();
    let p=d.get_array("profiles").unwrap()[0].as_document().unwrap();
    assert_eq!(d.get_str("activeProfileId").unwrap(),p.get_str("profileID").unwrap());
    assert_eq!(d.get_str("personality").unwrap(),"custom");
    let voice=d.get_document("voiceProfile").unwrap();
    assert_eq!(voice.get_str("cadence").unwrap(),"short and dynamic");
    assert_eq!(voice.get_str("style").unwrap(),"chat-native and expressive");
    assert!(voice.get_array("catchphrases").unwrap().is_empty());
}
#[test]
fn defaults_and_projection_precede_validation() {
    let rules=vec![Bson::Undefined];
    let input=doc! {"channelID":"1","channel":"x","personaMode":"invalid","activeProfileId":"missing","profiles":[{"personality":"profile personality","personaMode":"original"}],"rules":rules};
    let output=prepare_personality_validation(input,DateTime::from_millis(1000)).unwrap();
    let profile=output.get_array("profiles").unwrap()[0].as_document().unwrap();
    assert_eq!(profile.get_str("profileID").unwrap().len(),24);
    assert!(!profile.contains_key("_id"));
    assert_eq!(output.get_str("activeProfileId").unwrap(),profile.get_str("profileID").unwrap());
    assert_eq!(output.get_str("personaMode").unwrap(),"original");
    assert_eq!(output.get_array("rules").unwrap()[0].as_str().unwrap(),"Be respectful and friendly with users");
    for field in ["voiceProfile","learningConfig","memoryPolicy"] {assert!(!output.get_document(field).unwrap().contains_key("_id"));}
}

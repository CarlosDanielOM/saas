#![cfg(feature = "referral-service")]
use dima_rust::{schemas::referral_code,utils::referral::*};
use mongodb::bson::{doc,Bson};
#[test]
fn limits_and_errors() {
    for (plan,limit) in [(PlanType::Free,1),(PlanType::Premium,5),(PlanType::Pro,15)] {
        assert!(check_code_limit(plan,limit-1).is_ok());
        assert_eq!(check_code_limit(plan,limit).unwrap_err().to_string(),format!("Referral code limit reached for {} plan. Maximum {limit} codes allowed.",plan.as_str()));
    }
    assert_eq!(ReferralError::UserNotFound.to_string(),"User not found");
}
#[test]
fn code_validation_and_lookup() {
    assert!(referral_code::valid_code("Good_Code_123"));
    for code in ["","way_too_long_12345","invalid-code","é"] {assert!(!referral_code::valid_code(code));}
    assert_eq!(referral_code::validate_code("bad-code").unwrap_err().to_string(),"bad-code is not a valid referral code. Must be 1-16 alphanumeric characters or underscores.");
    let mut code=doc!{"code":"Ab_C"};referral_code::apply_save_rules(&mut code,true).unwrap();assert_eq!(code.get_str("code").unwrap(),"ab_c");
    assert_eq!(referral_code::find_by_code_filter("TeSt"),doc!{"code":"test","active":true});
}
#[test]
fn products_rewards_and_filter() {
    assert_eq!(get_plan_type_from_product_id(PRODUCT_ID_FREE),PlanType::Free);
    assert_eq!(get_plan_type_from_product_id(PRODUCT_ID_PREMIUM),PlanType::Premium);
    assert_eq!(get_plan_type_from_product_id(PRODUCT_ID_PRO),PlanType::Pro);
    assert_eq!(get_plan_type_from_product_id("unknown"),PlanType::Free);
    for (plan,cadence,amount) in [(PlanType::Free,SubscriptionCadence::Monthly,0),(PlanType::Free,SubscriptionCadence::Yearly,0),(PlanType::Premium,SubscriptionCadence::Monthly,50),(PlanType::Premium,SubscriptionCadence::Yearly,500),(PlanType::Pro,SubscriptionCadence::Monthly,100),(PlanType::Pro,SubscriptionCadence::Yearly,1000)] {assert_eq!(get_bot_subscription_reward_amount(plan,cadence),amount);}
    assert_eq!(completed_referral_reward_filter(),vec![Bson::Document(doc!{"type":"referral_bonus"}),Bson::Document(doc!{"type":"subscription_reward","metadata.rewardTargetType":"referrer","$or":[{"appliedAt":{"$type":"date"}},{"idempotencyKey":{"$exists":false}}]})]);
}

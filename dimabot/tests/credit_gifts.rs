#![cfg(feature = "credit-gifts")]
use dima_rust::utils::credit_gifts;

#[test]
fn recipient_normalization_and_validation() {
    assert_eq!(credit_gifts::normalize_recipient("  @Some_User  "), "some_user");
    assert!(credit_gifts::valid_recipient("some_user", true));
    assert!(!credit_gifts::valid_recipient("ab", true));
    assert!(!credit_gifts::valid_recipient("bad-name", false));
}

#[test]
fn announcement_locales_and_sanitization() {
    assert_eq!(credit_gifts::gift_announcement("a!", "b", 40_000, false), "🎁 @a gifted 40,000 permanent AI credits to @b. The credits are ready to use. Thank you!");
    assert_eq!(credit_gifts::gift_announcement("a", "b", 40_000, true), "🎁 @a regaló 40.000 créditos permanentes de IA a @b. ¡Ya están disponibles! ¡Gracias!");
}

#[test]
fn redirects_and_gift_identity() {
    assert!(credit_gifts::redirect_url("https://domdimabot.com/path", "domdimabot.com,www.domdimabot.com").is_ok());
    assert!(credit_gifts::redirect_url("http://domdimabot.com", "domdimabot.com").is_err());
    assert!(credit_gifts::redirect_url("https://other.example", "domdimabot.com").is_err());
    assert_eq!(credit_gifts::gift_id("buyer", "ABC"), credit_gifts::gift_id("buyer", "abc"));
}

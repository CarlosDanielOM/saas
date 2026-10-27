#![cfg(feature = "twitch-tokens")]

use dima_rust::utils::{
    credential_crypto::{CredentialCipher, StoredCredential},
    twitch_tokens::{CachedAccount, access_is_usable},
};
use serde_json::Value;

#[test]
fn node_source_crypto_and_expiry_corpus() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/token_storage_parity.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let input = &case["input"];
        match case["operation"].as_str().unwrap() {
            "key" => {
                let result = CredentialCipher::new(input["key"].as_str().unwrap());
                assert_eq!(result.is_err(), case["error"] == true, "key case");
            }
            "encrypt" => {
                let cipher = CredentialCipher::new("fixture").unwrap();
                let text = input["text"].as_str().unwrap();
                let iv = if input["iv"].as_str().unwrap() == "0000000000000000fffffffffffffffe" {
                    [
                        0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 254,
                    ]
                } else {
                    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
                };
                let encrypted = cipher.encrypt_with_iv(text, iv).unwrap();
                assert_eq!(serde_json::to_value(encrypted).unwrap(), case["expected"]);
            }
            "decrypt" => {
                let envelope = if input["envelope"].is_null() {
                    None
                } else {
                    Some(
                        serde_json::from_value::<StoredCredential>(input["envelope"].clone())
                            .unwrap(),
                    )
                };
                let result = CredentialCipher::new("fixture")
                    .unwrap()
                    .decrypt(envelope.as_ref());
                if case["error"] == true {
                    assert!(result.is_err());
                } else {
                    assert_eq!(
                        serde_json::to_value(result.unwrap()).unwrap(),
                        case["expected"]
                    );
                }
            }
            "usable" => {
                let account = CachedAccount {
                    access_token: input["token"].as_str().unwrap().into(),
                    expires_at: input["expiry"].as_str().unwrap_or_default().into(),
                    ..Default::default()
                };
                assert_eq!(
                    access_is_usable(
                        &account,
                        input["now"].as_i64().unwrap(),
                        input["skew"].as_i64().unwrap()
                    ),
                    case["expected"].as_bool().unwrap()
                );
            }
            _ => panic!("unrecognized fixture operation"),
        }
    }
}

#[test]
fn crypto_randomness_and_redacted_diagnostics() {
    let cipher = CredentialCipher::new("private-key-canary").unwrap();
    let first = cipher.encrypt("private-token-canary").unwrap();
    let second = cipher.encrypt("private-token-canary").unwrap();
    assert_ne!(first, second);
    assert_eq!(
        cipher.decrypt(Some(&first)).unwrap().as_deref(),
        Some("private-token-canary")
    );
    assert!(!format!("{cipher:?} {first:?}").contains("canary"));
    assert!(!format!("{first:?}").contains(first.content.as_deref().unwrap()));
    assert_eq!(
        cipher.encrypt("").unwrap(),
        StoredCredential {
            iv: Some("".into()),
            content: Some("".into())
        }
    );
    assert_eq!(
        cipher.decrypt(Some(&StoredCredential::default())).unwrap(),
        None
    );
}

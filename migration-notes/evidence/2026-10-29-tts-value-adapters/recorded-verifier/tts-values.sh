cargo fmt --all -- --check
sha256sum /artifacts/tts-value-adapters/expressive-tts-reference.json /artifacts/channel-tts-settings/channel-tts-settings-reference.json /artifacts/tts-credit-fallback/tts-credit-fallback-reference.json > /artifacts/tts-values-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features channel-tts-settings --lib --test expressive_lossless --test expressive_source --test channel_tts_settings_normalization --test channel_tts_settings_schema --test tts_utilities --test tts_credit_fallback --test js_string
EXPRESSIVE_TTS_FIXTURE_DIR=/artifacts/tts-value-adapters cargo test --locked --offline --no-default-features --features tts-utilities --test expressive_source -- --ignored --nocapture
CHANNEL_TTS_SETTINGS_REFERENCE=/artifacts/channel-tts-settings/channel-tts-settings-reference.json cargo test --locked --offline --no-default-features --features channel-tts-settings --test channel_tts_settings pure_source_cases_preserve_js_semantics_and_utf16 -- --ignored --nocapture
CHANNEL_TTS_SETTINGS_REFERENCE=/artifacts/channel-tts-settings/channel-tts-settings-reference.json cargo test --locked --offline --no-default-features --features channel-tts-settings --test channel_tts_settings_schema actual_mongoose_model_metadata_casts_and_validation -- --ignored --nocapture
TTS_CREDIT_FALLBACK_FIXTURE=/artifacts/tts-credit-fallback/tts-credit-fallback-reference.json cargo test --locked --offline --no-default-features --features tts-utilities --test tts_credit_fallback actual_source_replay -- --ignored --nocapture
cargo check --locked --offline --all-targets --no-default-features --features tts-utilities
cargo clippy --locked --offline --all-targets --no-default-features --features tts-utilities -- -D warnings
cargo check --locked --offline --all-targets --no-default-features --features channel-tts-settings
cargo clippy --locked --offline --all-targets --no-default-features --features channel-tts-settings -- -D warnings
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
sha256sum /artifacts/tts-value-adapters/expressive-tts-reference.json /artifacts/channel-tts-settings/channel-tts-settings-reference.json /artifacts/tts-credit-fallback/tts-credit-fallback-reference.json > /artifacts/tts-values-fixtures-after.sha256
cmp /artifacts/tts-values-fixtures-before.sha256 /artifacts/tts-values-fixtures-after.sha256

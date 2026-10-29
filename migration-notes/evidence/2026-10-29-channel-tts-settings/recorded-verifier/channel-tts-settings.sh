cargo fmt --all -- --check
sha256sum /artifacts/channel-tts-settings/channel-tts-settings-reference.json /artifacts/channel-tts-settings/channel-tts-settings-mongo.json /artifacts/channel-tts-settings/channel-tts-settings-benchmark-inputs.json /artifacts/channel-tts-settings/channel-tts-settings-node-benchmark.json /artifacts/tts-credit-fallback/tts-credit-fallback-reference.json > /artifacts/channel-tts-settings-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features channel-tts-settings --lib --test channel_tts_settings_normalization --test channel_tts_settings_schema --test tts_utilities --test tts_credit_fallback --test js_string
export CHANNEL_TTS_SETTINGS_REFERENCE=/artifacts/channel-tts-settings/channel-tts-settings-reference.json
export CHANNEL_TTS_SETTINGS_MONGO_REFERENCE=/artifacts/channel-tts-settings/channel-tts-settings-mongo.json
cargo test --locked --offline --no-default-features --features channel-tts-settings --test channel_tts_settings pure_source_cases_preserve_js_semantics_and_utf16 -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features channel-tts-settings --test channel_tts_settings_schema actual_mongoose_model_metadata_casts_and_validation -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features channel-tts-settings --test channel_tts_settings concrete_mongo_source_parity -- --ignored --nocapture
TTS_CREDIT_FALLBACK_FIXTURE=/artifacts/tts-credit-fallback/tts-credit-fallback-reference.json cargo test --locked --offline --no-default-features --features tts-utilities --test tts_credit_fallback actual_source_replay -- --ignored --nocapture
cargo check --locked --offline --all-targets --no-default-features --features channel-tts-settings
cargo clippy --locked --offline --all-targets --no-default-features --features channel-tts-settings -- -D warnings
cargo test --locked --offline --no-default-features --features tts-services --test tts_providers --test piper_tts --test kokoro_tts --test fish_voice_catalog
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
export CHANNEL_TTS_SETTINGS_BENCHMARK_INPUTS=/artifacts/channel-tts-settings/channel-tts-settings-benchmark-inputs.json
export CHANNEL_TTS_SETTINGS_BENCHMARK_OUTPUT=/artifacts/channel-tts-settings/channel-tts-settings-rust-benchmark.json
cargo test --release --locked --offline --no-default-features --features channel-tts-settings --test channel_tts_settings_benchmark prepared_settings_json_utf8_checksum -- --ignored --nocapture
sha256sum /artifacts/channel-tts-settings/channel-tts-settings-reference.json /artifacts/channel-tts-settings/channel-tts-settings-mongo.json /artifacts/channel-tts-settings/channel-tts-settings-benchmark-inputs.json /artifacts/channel-tts-settings/channel-tts-settings-node-benchmark.json /artifacts/tts-credit-fallback/tts-credit-fallback-reference.json > /artifacts/channel-tts-settings-fixtures-after.sha256
cmp /artifacts/channel-tts-settings-fixtures-before.sha256 /artifacts/channel-tts-settings-fixtures-after.sha256

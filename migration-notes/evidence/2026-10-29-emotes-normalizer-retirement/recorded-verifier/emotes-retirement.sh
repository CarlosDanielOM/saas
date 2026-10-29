cargo fmt --all -- --check
find /artifacts/emotes-normalizer-retirement -name '*.json' -type f -exec sha256sum {} \; | sort > /artifacts/emotes-retirement-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features twitch-emotes --lib --test twitch_emotes
DIMA_TWITCH_EMOTES_FIXTURE_DIR=/artifacts/emotes-normalizer-retirement/emotes DIMA_TWITCH_EMOTES_NAMESPACE=emotes-fixture-20261029validation1: cargo test --locked --offline --no-default-features --features twitch-emotes --test twitch_emotes -- --ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features tts-services,channel-tts-settings --lib --test expressive_tag_types --test expressive_lossless --test expressive_source --test tts_utilities --test tts_credit_fallback --test js_string --test channel_tts_settings_normalization --test channel_tts_settings_schema --test tts_providers --test piper_tts --test kokoro_tts --test tts_runtime
DIMA_TTS_LOSSLESS_FIXTURES=/artifacts/emotes-normalizer-retirement/lossless cargo test --locked --offline --no-default-features --features tts-utilities --test tts_utilities lossless_actual_source_replay -- --ignored --nocapture
EXPRESSIVE_TTS_FIXTURE_DIR=/artifacts/emotes-normalizer-retirement/expressive cargo test --locked --offline --no-default-features --features tts-utilities --test expressive_source -- --ignored --nocapture
TTS_CREDIT_FALLBACK_FIXTURE=/artifacts/emotes-normalizer-retirement/credit/tts-credit-fallback-reference.json cargo test --locked --offline --no-default-features --features tts-utilities --test tts_credit_fallback -- --ignored --nocapture
CHANNEL_TTS_SETTINGS_REFERENCE=/artifacts/emotes-normalizer-retirement/settings/channel-tts-settings-reference.json cargo test --locked --offline --no-default-features --features channel-tts-settings --test channel_tts_settings pure_source_cases_preserve_js_semantics_and_utf16 -- --ignored --nocapture
CHANNEL_TTS_SETTINGS_REFERENCE=/artifacts/emotes-normalizer-retirement/settings/channel-tts-settings-reference.json cargo test --locked --offline --no-default-features --features channel-tts-settings --test channel_tts_settings_schema actual_mongoose_model_metadata_casts_and_validation -- --ignored --nocapture
FISH_TTS_FIXTURE_DIR=/artifacts/emotes-normalizer-retirement/fish cargo test --locked --offline --no-default-features --features tts-services --test tts_providers typescript_service_fixture_replay -- --ignored --nocapture
PIPER_KOKORO_FIXTURE_DIR=/artifacts/emotes-normalizer-retirement/piper-kokoro cargo test --locked --offline --no-default-features --features tts-services --test piper_tts replay_piper_source_fixture -- --ignored --nocapture
PIPER_KOKORO_FIXTURE_DIR=/artifacts/emotes-normalizer-retirement/piper-kokoro cargo test --locked --offline --no-default-features --features tts-services --test kokoro_tts replay_kokoro_source_fixture -- --ignored --nocapture
TTS_RUNTIME_FIXTURE_DIR=/artifacts/emotes-normalizer-retirement/runtime cargo test --locked --offline --no-default-features --features tts-services --test tts_runtime -- --ignored --nocapture
cargo check --locked --offline --all-targets --no-default-features --features twitch-emotes
cargo clippy --locked --offline --all-targets --no-default-features --features twitch-emotes -- -D warnings
cargo check --locked --offline --all-targets --no-default-features --features tts-utilities
cargo clippy --locked --offline --all-targets --no-default-features --features tts-utilities -- -D warnings
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
find /artifacts/emotes-normalizer-retirement -name '*.json' -type f -exec sha256sum {} \; | sort > /artifacts/emotes-retirement-fixtures-after.sha256
cmp /artifacts/emotes-retirement-fixtures-before.sha256 /artifacts/emotes-retirement-fixtures-after.sha256

cargo fmt --all -- --check
sha256sum /artifacts/tts-credit-fallback/tts-credit-fallback-reference.json > /artifacts/tts-credit-fallback-fixtures-before.sha256
cargo check --locked --offline --all-targets --no-default-features --features tts-utilities
cargo clippy --locked --offline --all-targets --no-default-features --features tts-utilities -- -D warnings
cargo test --locked --offline --no-default-features --features tts-utilities --lib --test tts_credit_fallback --test tts_utilities --test js_string
TTS_CREDIT_FALLBACK_FIXTURE=/artifacts/tts-credit-fallback/tts-credit-fallback-reference.json cargo test --locked --offline --no-default-features --features tts-utilities --test tts_credit_fallback actual_source_replay -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features tts-services --test tts_providers --test piper_tts --test kokoro_tts --test fish_voice_catalog
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
sha256sum /artifacts/tts-credit-fallback/tts-credit-fallback-reference.json > /artifacts/tts-credit-fallback-fixtures-after.sha256
cmp /artifacts/tts-credit-fallback-fixtures-before.sha256 /artifacts/tts-credit-fallback-fixtures-after.sha256

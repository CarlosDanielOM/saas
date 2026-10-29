cargo fmt --all -- --check
sha256sum /artifacts/tts-tag-types/expressive-tts-reference.json > /artifacts/tts-tag-types-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features tts-utilities --lib --test expressive_tag_types --test expressive_lossless --test expressive_source --test tts_utilities --test tts_credit_fallback --test js_string
EXPRESSIVE_TTS_FIXTURE_DIR=/artifacts/tts-tag-types cargo test --locked --offline --no-default-features --features tts-utilities --test expressive_source -- --ignored --nocapture
cargo check --locked --offline --all-targets --no-default-features --features tts-utilities
cargo clippy --locked --offline --all-targets --no-default-features --features tts-utilities -- -D warnings
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
sha256sum /artifacts/tts-tag-types/expressive-tts-reference.json > /artifacts/tts-tag-types-fixtures-after.sha256
cmp /artifacts/tts-tag-types-fixtures-before.sha256 /artifacts/tts-tag-types-fixtures-after.sha256

set -eu
cargo fmt --all -- --check
cargo check --locked --offline --all-targets --no-default-features --features tts-utilities,redis
cargo clippy --locked --offline --all-targets --no-default-features --features tts-utilities,redis -- -D warnings
DIMA_TTS_PLAYBACK_FIXTURES=/artifacts/tts-session-playback cargo test --locked --offline --no-default-features --features tts-utilities,redis --test tts_session_playback -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features tts-utilities --test tts_utilities --test js_string
cargo check --locked --offline --keep-going --all-targets --all-features
cargo clippy --locked --offline --keep-going --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features

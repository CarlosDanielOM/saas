set -eu
cargo fmt --all -- --check
cargo check --locked --offline --all-targets --no-default-features --features tts-utilities
cargo clippy --locked --offline --all-targets --no-default-features --features tts-utilities -- -D warnings
cargo test --locked --offline --no-default-features --features tts-utilities --lib utils::js_string
cargo test --locked --offline --no-default-features --features tts-utilities --test js_string --test tts_utilities --no-fail-fast
cargo check --locked --offline --keep-going --all-targets --all-features
cargo clippy --locked --offline --keep-going --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
DIMA_TTS_BENCH_FIXTURES=/artifacts/tts-normalization-prepared/fixtures.json DIMA_TTS_BENCH_OUTPUT=/artifacts/tts-normalization-rust.json cargo test --release --locked --offline --no-default-features --features tts-utilities --test tts_utilities normalization_benchmark -- --ignored --nocapture

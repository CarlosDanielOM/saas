set -eu
cargo fmt --all -- --check
cargo check --locked --offline --all-targets --no-default-features --features tts-services
cargo clippy --locked --offline --all-targets --no-default-features --features tts-services -- -D warnings
cargo test --locked --offline --no-default-features --features tts-services --lib
cargo test --locked --offline --no-default-features --features tts-services --test tts_providers -- --nocapture
FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts cargo test --locked --offline --no-default-features --features tts-services --test tts_providers sdk_source_fixture_matches_encoder_and_http_wire -- --ignored --exact --nocapture
FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts cargo test --locked --offline --no-default-features --features tts-services --test tts_providers sdk_source_fixture_matches_direct_error_messages -- --ignored --exact --nocapture
FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts cargo test --locked --offline --no-default-features --features tts-services --test tts_providers typescript_service_fixture_replay -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features tts-utilities --test js_string --test tts_utilities
cargo check --locked --offline --keep-going --all-targets --all-features
cargo clippy --locked --offline --keep-going --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts FISH_MSGPACK_BENCH_OUTPUT=/artifacts/fish-tts/rust-benchmark.json cargo test --release --locked --offline --no-default-features --features tts-services --test tts_providers fish_msgpack_encoding_benchmark -- --ignored --exact --nocapture

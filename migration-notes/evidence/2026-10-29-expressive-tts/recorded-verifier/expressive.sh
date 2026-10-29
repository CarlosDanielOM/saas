cargo fmt --all -- --check
sha256sum /artifacts/expressive-tts/expressive-tts-reference.json /artifacts/expressive-tts/expressive-benchmark-inputs.json /artifacts/expressive-tts/expressive-node-benchmark.json /artifacts/tts-credit-fallback/tts-credit-fallback-reference.json /artifacts/fish-tts/fish-sdk-protocol.json /artifacts/fish-tts/fish-tts-reference.json > /artifacts/expressive-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features tts-services --lib --test expressive_lossless --test expressive_source --test expressive_benchmark --test tts_utilities --test tts_credit_fallback --test tts_providers --test js_string
EXPRESSIVE_TTS_FIXTURE_DIR=/artifacts/expressive-tts cargo test --locked --offline --no-default-features --features tts-utilities --test expressive_source -- --ignored --nocapture
TTS_CREDIT_FALLBACK_FIXTURE=/artifacts/tts-credit-fallback/tts-credit-fallback-reference.json cargo test --locked --offline --no-default-features --features tts-utilities --test tts_credit_fallback -- --ignored --nocapture
FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts cargo test --locked --offline --no-default-features --features tts-services --test tts_providers sdk_source_fixture_matches -- --ignored --nocapture
FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts cargo test --locked --offline --no-default-features --features tts-services --test tts_providers typescript_service_fixture_replay -- --ignored --nocapture
python3 /task-tools/expressive-negative.py
cargo check --locked --offline --all-targets --no-default-features --features tts-utilities
cargo clippy --locked --offline --all-targets --no-default-features --features tts-utilities -- -D warnings
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
export EXPRESSIVE_TTS_BENCHMARK_DIR=/artifacts/expressive-tts
export EXPRESSIVE_TTS_INPUT_SHA256=$(sha256sum /artifacts/expressive-tts/expressive-benchmark-inputs.json | cut -d ' ' -f 1)
cargo test --release --locked --offline --no-default-features --features tts-utilities --test expressive_benchmark -- --ignored --nocapture
test "$EXPRESSIVE_TTS_INPUT_SHA256" = "$(sha256sum /artifacts/expressive-tts/expressive-benchmark-inputs.json | cut -d ' ' -f 1)"
sha256sum /artifacts/expressive-tts/expressive-tts-reference.json /artifacts/expressive-tts/expressive-benchmark-inputs.json /artifacts/expressive-tts/expressive-node-benchmark.json /artifacts/tts-credit-fallback/tts-credit-fallback-reference.json /artifacts/fish-tts/fish-sdk-protocol.json /artifacts/fish-tts/fish-tts-reference.json > /artifacts/expressive-fixtures-after.sha256
cmp /artifacts/expressive-fixtures-before.sha256 /artifacts/expressive-fixtures-after.sha256

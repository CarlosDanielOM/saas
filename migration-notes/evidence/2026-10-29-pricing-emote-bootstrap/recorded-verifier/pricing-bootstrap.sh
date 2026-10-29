cargo fmt --all -- --check
find /artifacts/pricing-emote-bootstrap -name '*.json' -type f -exec sha256sum {} \; | sort > /artifacts/pricing-bootstrap-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features twitch-emotes --lib --test twitch_emotes --test twitch_emotes_runtime
DIMA_TWITCH_EMOTES_FIXTURE_DIR=/artifacts/pricing-emote-bootstrap/emotes DIMA_TWITCH_EMOTES_NAMESPACE=emotes-fixture-20261029pricing1: cargo test --locked --offline --no-default-features --features twitch-emotes --test twitch_emotes --test twitch_emotes_runtime -- --ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features credit-policy --lib
cargo test --locked --offline --no-default-features --features chat-message,timer-policy,credit-policy --test policy_utils_parity
cargo test --locked --offline --no-default-features --features tts-services,channel-tts-settings --lib --test expressive_tag_types --test expressive_lossless --test expressive_source --test tts_utilities --test tts_credit_fallback --test js_string --test channel_tts_settings_normalization --test channel_tts_settings_schema --test tts_providers --test piper_tts --test kokoro_tts --test tts_runtime --test tts_usage_pricing
cargo test --locked --offline --no-default-features --features tts-utilities,credit-policy --test tts_usage_pricing
DIMA_TTS_USAGE_FIXTURE_DIR=/artifacts/pricing-emote-bootstrap/pricing cargo test --locked --offline --no-default-features --features tts-utilities --test tts_usage_pricing -- --ignored --nocapture
cargo check --locked --offline --all-targets --no-default-features --features credit-policy
cargo clippy --locked --offline --all-targets --no-default-features --features credit-policy -- -D warnings
cargo check --locked --offline --all-targets --no-default-features --features twitch-emotes
cargo clippy --locked --offline --all-targets --no-default-features --features twitch-emotes -- -D warnings
cargo check --locked --offline --all-targets --no-default-features --features tts-utilities
cargo clippy --locked --offline --all-targets --no-default-features --features tts-utilities -- -D warnings
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
find /artifacts/pricing-emote-bootstrap -name '*.json' -type f -exec sha256sum {} \; | sort > /artifacts/pricing-bootstrap-fixtures-after.sha256
cmp /artifacts/pricing-bootstrap-fixtures-before.sha256 /artifacts/pricing-bootstrap-fixtures-after.sha256
input_file=/artifacts/pricing-emote-bootstrap/benchmark/tts-usage-benchmark-input.json
sha256sum "$input_file" > /artifacts/pricing-bootstrap-benchmark-before.sha256
input_sha=$(cut -d ' ' -f 1 /artifacts/pricing-bootstrap-benchmark-before.sha256)
DIMA_TTS_USAGE_BENCHMARK_DIR=/artifacts/pricing-emote-bootstrap/benchmark DIMA_TTS_USAGE_INPUT_SHA256="$input_sha" cargo test --release --locked --offline --no-default-features --features tts-utilities --test tts_usage_benchmark prepared_usage -- --ignored --nocapture
sha256sum "$input_file" > /artifacts/pricing-bootstrap-benchmark-after.sha256
cmp /artifacts/pricing-bootstrap-benchmark-before.sha256 /artifacts/pricing-bootstrap-benchmark-after.sha256

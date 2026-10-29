cargo fmt --all -- --check
find /artifacts/tts-lossless-normalization/reference -name '*.json' -type f -exec sha256sum {} \; | sort > /artifacts/tts-lossless-fixtures-before.sha256
find /artifacts/tts-utility-retirement -name '*.json' -type f -exec sha256sum {} \; | sort >> /artifacts/tts-lossless-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features tts-services,channel-tts-settings --lib --test expressive_tag_types --test expressive_lossless --test expressive_source --test tts_utilities --test tts_credit_fallback --test js_string --test channel_tts_settings_normalization --test channel_tts_settings_schema --test tts_providers --test piper_tts --test kokoro_tts --test tts_runtime --test tts_lossless_benchmark
DIMA_TTS_LOSSLESS_FIXTURES=/artifacts/tts-lossless-normalization/reference cargo test --locked --offline --no-default-features --features tts-utilities --test tts_utilities lossless_actual_source_replay -- --ignored --nocapture
EXPRESSIVE_TTS_FIXTURE_DIR=/artifacts/tts-utility-retirement/expressive cargo test --locked --offline --no-default-features --features tts-utilities --test expressive_source -- --ignored --nocapture
TTS_CREDIT_FALLBACK_FIXTURE=/artifacts/tts-utility-retirement/credit/tts-credit-fallback-reference.json cargo test --locked --offline --no-default-features --features tts-utilities --test tts_credit_fallback -- --ignored --nocapture
FISH_TTS_FIXTURE_DIR=/artifacts/tts-utility-retirement/fish cargo test --locked --offline --no-default-features --features tts-services --test tts_providers typescript_service_fixture_replay -- --ignored --nocapture
PIPER_KOKORO_FIXTURE_DIR=/artifacts/tts-utility-retirement/piper-kokoro cargo test --locked --offline --no-default-features --features tts-services --test piper_tts replay_piper_source_fixture -- --ignored --nocapture
PIPER_KOKORO_FIXTURE_DIR=/artifacts/tts-utility-retirement/piper-kokoro cargo test --locked --offline --no-default-features --features tts-services --test kokoro_tts replay_kokoro_source_fixture -- --ignored --nocapture
TTS_RUNTIME_FIXTURE_DIR=/artifacts/tts-utility-retirement/runtime cargo test --locked --offline --no-default-features --features tts-services --test tts_runtime -- --ignored --nocapture
cargo check --locked --offline --all-targets --no-default-features --features tts-utilities
cargo clippy --locked --offline --all-targets --no-default-features --features tts-utilities -- -D warnings
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
sha256sum /artifacts/tts-lossless-normalization/benchmark/tts-lossless-benchmark-inputs.json > /artifacts/tts-lossless-benchmark-input-before.sha256
DIMA_TTS_LOSSLESS_INPUT_SHA256=$(cut -d ' ' -f 1 /artifacts/tts-lossless-benchmark-input-before.sha256)
export DIMA_TTS_LOSSLESS_INPUT_SHA256
DIMA_TTS_LOSSLESS_BENCHMARK_DIR=/artifacts/tts-lossless-normalization/benchmark cargo test --release --locked --offline --no-default-features --features tts-utilities --test tts_lossless_benchmark -- --ignored --nocapture
sha256sum /artifacts/tts-lossless-normalization/benchmark/tts-lossless-benchmark-inputs.json > /artifacts/tts-lossless-benchmark-input-after.sha256
cmp /artifacts/tts-lossless-benchmark-input-before.sha256 /artifacts/tts-lossless-benchmark-input-after.sha256
find /artifacts/tts-lossless-normalization/reference -name '*.json' -type f -exec sha256sum {} \; | sort > /artifacts/tts-lossless-fixtures-after.sha256
find /artifacts/tts-utility-retirement -name '*.json' -type f -exec sha256sum {} \; | sort >> /artifacts/tts-lossless-fixtures-after.sha256
cmp /artifacts/tts-lossless-fixtures-before.sha256 /artifacts/tts-lossless-fixtures-after.sha256

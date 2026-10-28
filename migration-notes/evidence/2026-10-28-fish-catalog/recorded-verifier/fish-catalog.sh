set -eu
cargo fmt --all -- --check
sha256sum /artifacts/fish-catalog/fish-catalog-reference.json /artifacts/fish-catalog/fish-catalog-benchmark-inputs.json > /artifacts/fish-catalog-fixtures-before.sha256
cargo check --locked --offline --all-targets --no-default-features --features tts-services
cargo clippy --locked --offline --all-targets --no-default-features --features tts-services -- -D warnings
cargo test --locked --offline --no-default-features --features tts-services --lib
cargo test --locked --offline --no-default-features --features tts-services --test fish_voice_catalog --test piper_tts --test kokoro_tts --test tts_providers -- --nocapture
FISH_CATALOG_FIXTURE_DIR=/artifacts/fish-catalog cargo test --locked --offline --no-default-features --features tts-services --test fish_voice_catalog typescript_catalog_fixture_replay -- --ignored --exact --nocapture
PIPER_KOKORO_FIXTURE_DIR=/artifacts/piper-kokoro cargo test --locked --offline --no-default-features --features tts-services --test kokoro_tts replay_kokoro_source_fixture -- --ignored --exact --nocapture
PIPER_KOKORO_FIXTURE_DIR=/artifacts/piper-kokoro cargo test --locked --offline --no-default-features --features tts-services --test piper_tts replay_piper_source_fixture -- --ignored --exact --nocapture
for behavior in sdk_source_fixture_matches_encoder_and_http_wire sdk_source_fixture_matches_direct_error_messages typescript_service_fixture_replay; do
  FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts cargo test --locked --offline --no-default-features --features tts-services --test tts_providers "$behavior" -- --ignored --exact --nocapture
done
cargo test --locked --offline --no-default-features --features tts-utilities --test tts_utilities --test js_string
cargo check --locked --offline --keep-going --all-targets --all-features
cargo clippy --locked --offline --keep-going --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
FISH_CATALOG_FIXTURE_DIR=/artifacts/fish-catalog FISH_CATALOG_BENCH_OUTPUT=/artifacts/fish-catalog/fish-catalog-benchmark-rust.json cargo test --release --locked --offline --no-default-features --features tts-services --test fish_voice_catalog fish_catalog_normalization_benchmark -- --ignored --exact --nocapture
sha256sum /artifacts/fish-catalog/fish-catalog-reference.json /artifacts/fish-catalog/fish-catalog-benchmark-inputs.json > /artifacts/fish-catalog-fixtures-after.sha256
cmp /artifacts/fish-catalog-fixtures-before.sha256 /artifacts/fish-catalog-fixtures-after.sha256

cargo fmt --all -- --check
sha256sum /artifacts/tts-runtime/tts_runtime_reference.json /artifacts/tts-runtime/tts_runtime_dynamic_reference.json /artifacts/fish-tts/fish-sdk-protocol.json /artifacts/fish-tts/fish-tts-reference.json /artifacts/piper-kokoro/piper-kokoro-reference.json /artifacts/fish-catalog/fish-catalog-reference.json > /artifacts/tts-runtime-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features tts-services --lib --test tts_runtime --test tts_providers --test piper_tts --test kokoro_tts --test fish_voice_catalog --test tts_utilities --test js_string
TTS_RUNTIME_FIXTURE_DIR=/artifacts/tts-runtime cargo test --locked --offline --no-default-features --features tts-services --test tts_runtime -- --ignored --nocapture
export FISH_TTS_FIXTURE_DIR=/artifacts/fish-tts
export PIPER_KOKORO_FIXTURE_DIR=/artifacts/piper-kokoro
export FISH_CATALOG_FIXTURE_DIR=/artifacts/fish-catalog
cargo test --locked --offline --no-default-features --features tts-services --test tts_providers sdk_source_fixture_matches -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features tts-services --test tts_providers typescript_service_fixture_replay -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features tts-services --test piper_tts replay_piper_source_fixture -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features tts-services --test kokoro_tts replay_kokoro_source_fixture -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features tts-services --test fish_voice_catalog typescript_catalog_fixture_replay -- --ignored --nocapture
cargo check --locked --offline --all-targets --no-default-features --features tts-services
cargo clippy --locked --offline --all-targets --no-default-features --features tts-services -- -D warnings
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
sha256sum /artifacts/tts-runtime/tts_runtime_reference.json /artifacts/tts-runtime/tts_runtime_dynamic_reference.json /artifacts/fish-tts/fish-sdk-protocol.json /artifacts/fish-tts/fish-tts-reference.json /artifacts/piper-kokoro/piper-kokoro-reference.json /artifacts/fish-catalog/fish-catalog-reference.json > /artifacts/tts-runtime-fixtures-after.sha256
cmp /artifacts/tts-runtime-fixtures-before.sha256 /artifacts/tts-runtime-fixtures-after.sha256

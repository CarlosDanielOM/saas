set -eu
wave=/artifacts/posthog-payload-performance/attempt3
features=posthog-benchmark,ai-usage-receipt-parser,ai-usage-producer,ai-credit-projection,tts-services,channel-tts-settings,ast-pure-functions,twitch-emotes
export TZ=UTC
export POSTHOG_TRACKING_FIXTURES="$wave/tracking"
export POSTHOG_LOSSLESS_REFERENCE_DIR="$wave/transport"
export DIMA_JSON_NUMBER_REFERENCE_DIR="$wave/numbers"
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$wave/parser"
export DIMA_AI_RECEIPT_NODE_ROOT=/artifacts/posthog-receipt/attempt1/node-provenance/root
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_USAGE_PRODUCER_FIXTURE_DIR="$wave/producer"
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-perf20261029native1:
export DIMA_AI_PROJECTION_REFERENCE_DIR="$wave/projection"
export DIMA_AI_PROJECTION_NODE_BINARY=/artifacts/ai-credit-receipt/runtime-provenance/node
export DIMA_AI_PROJECTION_TYPESCRIPT_IMPLEMENTATION=/artifacts/ai-credit-receipt/runtime-provenance/typescript
export DIMA_AI_PROJECTION_TYPESCRIPT_PACKAGE=/artifacts/ai-credit-receipt/runtime-provenance/typescriptPackage
export DIMA_TTS_LOSSLESS_FIXTURES="$wave/normalization"
export EXPRESSIVE_TTS_FIXTURE_DIR="$wave/expressive"
export TTS_CREDIT_FALLBACK_FIXTURE="$wave/credit/tts-credit-fallback-reference.json"
export CHANNEL_TTS_SETTINGS_REFERENCE="$wave/settings/channel-tts-settings-reference.json"
export FISH_TTS_FIXTURE_DIR="$wave/fish"
export PIPER_KOKORO_FIXTURE_DIR="$wave/piper-kokoro"
export TTS_RUNTIME_FIXTURE_DIR="$wave/runtime"
export DIMA_TTS_USAGE_FIXTURE_DIR="$wave/pricing"
export DIMA_TWITCH_EMOTES_FIXTURE_DIR="$wave/emotes"
export DIMA_TWITCH_EMOTES_NAMESPACE=emotes-fixture-perf20261029native1:
find "$wave" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/shared-fixtures-before.sha256"
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features "$features" --lib \
  --test posthog_tracking --test posthog_lossless --test json_number_parity \
  --test lossless_json_view --test ai_usage_receipt_parser --test ai_usage_producer \
  --test ai_credit_projection --test ast_evaluator_parity --test js_string \
  --test tts_utilities --test expressive_tag_types --test expressive_lossless \
  --test tts_credit_fallback --test tts_usage_pricing \
  --test channel_tts_settings_normalization --test channel_tts_settings_schema \
  --test tts_providers --test piper_tts --test kokoro_tts --test tts_runtime \
  --test fish_voice_catalog -- --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test json_number_parity replay_every_binary64_engine_wire -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test posthog_tracking -- --ignored --nocapture
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
  TZ="$zone" cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact --nocapture
done
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_producer replay_actual_source_fixture -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test ai_credit_projection replay_every_actual_source_case -- --ignored --exact --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features "$features" --test tts_utilities lossless_actual_source_replay -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test expressive_source -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test tts_credit_fallback actual_source_replay -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test tts_usage_pricing actual_source_pricing -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test channel_tts_settings pure_source_cases_preserve_js_semantics_and_utf16 -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test channel_tts_settings_schema actual_mongoose_model_metadata_casts_and_validation -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test tts_providers typescript_service_fixture_replay -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test piper_tts replay_piper_source_fixture -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test kokoro_tts replay_kokoro_source_fixture -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test tts_runtime -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_producer_redis -- --ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features "$features" --test ai_credit_projection_redis -- --ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features "$features" --test twitch_emotes actual_source_replay_with_native_adapters -- --ignored --exact --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features "$features" --test twitch_emotes_runtime -- --ignored --nocapture --test-threads=1
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --keep-going --locked --offline --all-features --all-targets -- -D warnings
find "$wave" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/shared-fixtures-after.sha256"
cmp "$wave/shared-fixtures-before.sha256" "$wave/shared-fixtures-after.sha256"

set -eu
export POSTHOG_RS_SOURCE=/source/verification/posthog-rs
export TZ=UTC
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-perf20261029native1:
wave=/artifacts/posthog-payload-performance/attempt3
mkdir -p "$wave/parser" "$wave/producer" "$wave/projection"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$wave/parser"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$wave/parser"
node tests/fixtures/posthog_tracking_reference.cjs --check "$wave/tracking"
node tests/fixtures/posthog_tracking_reference.cjs --check "$wave/tracking"
node tests/fixtures/posthog_lossless_reference.cjs --check "$wave/transport"
node tests/fixtures/posthog_lossless_reference.cjs --check "$wave/transport"
node tests/fixtures/ai_usage_producer_reference.cjs --check "$wave/producer"
node tests/fixtures/ai_usage_producer_reference.cjs --check "$wave/producer"
node tests/fixtures/ai_credit_projection_reference.cjs --check "$wave/projection"
node tests/fixtures/ai_credit_projection_reference.cjs --check "$wave/projection"
node tests/fixtures/tts_source_resolver.test.cjs
node tests/fixtures/tts_utilities_reference.mjs --check
node tests/fixtures/tts_lossless_reference.cjs --check "$wave/normalization"
node tests/fixtures/tts_lossless_reference.cjs --check "$wave/normalization"
node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --check "$wave/expressive"
node --experimental-vm-modules tests/fixtures/expressive_tts_reference.mjs --check "$wave/expressive"
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --check "$wave/credit"
node --experimental-vm-modules tests/fixtures/tts_credit_fallback_reference.mjs --check "$wave/credit"
node tests/fixtures/channel_tts_settings_reference.mjs --check "$wave/settings"
node tests/fixtures/channel_tts_settings_reference.mjs --check "$wave/settings"
node --experimental-vm-modules tests/fixtures/fish_tts_reference.mjs --check "$wave/fish"
node --experimental-vm-modules tests/fixtures/fish_tts_reference.mjs --check "$wave/fish"
node --experimental-vm-modules tests/fixtures/piper_kokoro_reference.mjs --check "$wave/piper-kokoro"
node --experimental-vm-modules tests/fixtures/piper_kokoro_reference.mjs --check "$wave/piper-kokoro"
node tests/fixtures/tts_runtime_reference.mjs --check "$wave/runtime"
node tests/fixtures/tts_runtime_reference.mjs --check "$wave/runtime"
node --experimental-vm-modules tests/fixtures/tts_runtime_dynamic_reference.mjs --check "$wave/runtime"
node --experimental-vm-modules tests/fixtures/tts_runtime_dynamic_reference.mjs --check "$wave/runtime"
node tests/fixtures/twitch_emotes_reference.cjs --check "$wave/emotes"
node tests/fixtures/twitch_emotes_reference.cjs --check "$wave/emotes"
node tests/fixtures/ast_evaluator_reference.mjs --check

mkdir -p "$wave/pricing"
node tests/fixtures/tts_usage_oracle.cjs --check "$wave/pricing"
node tests/fixtures/tts_usage_oracle.cjs --check "$wave/pricing"
node tests/fixtures/json_number_reference.cjs --check "$wave/numbers"

node tests/fixtures/posthog_tracking_benchmark.cjs --check "$wave/benchmark"

node tests/fixtures/application_schemas_reference.mjs --check
node tests/fixtures/additional_schemas_reference.mjs --check
node tests/fixtures/keyword_native_reference.mjs --check
node tests/fixtures/mongoose_date_reference.mjs /artifacts/posthog-payload-performance/attempt3/mongoose-date

set -eu
export TZ=UTC
export POSTHOG_RS_SOURCE=/source/verification/posthog-rs
wave=/artifacts/receipt-parser-benchmark/attempt3
mkdir -p "$wave/parser" "$wave/tracking" "$wave/transport" "$wave/producer" "$wave/projection" "$wave/pricing"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --write "$wave/parser"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$wave/parser"
node tests/fixtures/posthog_tracking_reference.cjs --write "$wave/tracking"
node tests/fixtures/posthog_tracking_reference.cjs --check "$wave/tracking"
node tests/fixtures/posthog_lossless_reference.cjs --write "$wave/transport"
node tests/fixtures/posthog_lossless_reference.cjs --check "$wave/transport"
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-wire20261029native1:
node tests/fixtures/ai_usage_producer_reference.cjs --write "$wave/producer"
node tests/fixtures/ai_usage_producer_reference.cjs --check "$wave/producer"
node tests/fixtures/ai_credit_projection_reference.cjs --write "$wave/projection"
node tests/fixtures/ai_credit_projection_reference.cjs --check "$wave/projection"
node tests/fixtures/tts_usage_oracle.cjs --write "$wave/pricing"
node tests/fixtures/tts_usage_oracle.cjs --check "$wave/pricing"

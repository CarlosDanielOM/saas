set -eu
export POSTHOG_RS_SOURCE=/source/verification/posthog-rs
wave=/artifacts/posthog-receipt/attempt4
mkdir -p "$wave/parser" "$wave/tracking" "$wave/transport" "$wave/benchmark"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --write "$wave/parser"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$wave/parser"
cp /artifacts/posthog-receipt/attempt2/tracking/posthog_tracking.json "$wave/tracking/"
cp /artifacts/posthog-receipt/attempt3/transport/reference.json "$wave/transport/"
cp /artifacts/posthog-receipt/attempt2/benchmark/input.json /artifacts/posthog-receipt/attempt2/benchmark/node-report.json "$wave/benchmark/"
node tests/fixtures/posthog_tracking_reference.cjs --check "$wave/tracking"
node tests/fixtures/posthog_lossless_reference.cjs --check "$wave/transport"
sha256sum "$wave/benchmark/input.json" > "$wave/benchmark-input-before.sha256"

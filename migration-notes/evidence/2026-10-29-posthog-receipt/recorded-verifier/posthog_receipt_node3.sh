set -eu
export POSTHOG_RS_SOURCE=/source/verification/posthog-rs
wave=/artifacts/posthog-receipt/attempt3
prior=/artifacts/posthog-receipt/attempt2
mkdir -p "$wave/parser" "$wave/tracking" "$wave/benchmark"
cp "$prior/parser/ai_usage_receipt_parser_reference.json" "$wave/parser/"
cp "$prior/tracking/posthog_tracking.json" "$wave/tracking/"
cp "$prior/benchmark/input.json" "$prior/benchmark/node-report.json" "$wave/benchmark/"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$wave/parser"
node tests/fixtures/posthog_tracking_reference.cjs --check "$wave/tracking"
node tests/fixtures/posthog_lossless_reference.cjs --write "$wave/transport"
node tests/fixtures/posthog_lossless_reference.cjs --check "$wave/transport"
sha256sum "$wave/benchmark/input.json" > "$wave/benchmark-input-before.sha256"

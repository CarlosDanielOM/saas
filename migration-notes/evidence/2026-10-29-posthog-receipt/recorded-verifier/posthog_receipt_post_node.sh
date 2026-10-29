set -eu
export POSTHOG_RS_SOURCE=/source/verification/posthog-rs
wave=/artifacts/posthog-receipt/attempt4
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$wave/parser"
node tests/fixtures/posthog_tracking_reference.cjs --check "$wave/tracking"
node tests/fixtures/posthog_lossless_reference.cjs --check "$wave/transport"
node tests/fixtures/posthog_tracking_benchmark.cjs --check "$wave/benchmark"
sha256sum "$wave/benchmark/input.json" > "$wave/benchmark-input-post-node.sha256"
cmp "$wave/benchmark-input-before.sha256" "$wave/benchmark-input-post-node.sha256"

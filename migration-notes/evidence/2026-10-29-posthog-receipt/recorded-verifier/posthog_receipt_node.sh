set -eu
export POSTHOG_RS_SOURCE=/source/verification/posthog-rs
wave=/artifacts/posthog-receipt/attempt1
mkdir -p "$wave/parser"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --write "$wave/parser"
node tests/fixtures/ai_usage_receipt_parser_reference.cjs --check "$wave/parser"
node /task-tools/copy_receipt_node_provenance.cjs "$wave/parser/ai_usage_receipt_parser_reference.json" "$wave/node-provenance"
node tests/fixtures/posthog_tracking_reference.cjs --write "$wave/tracking"
node tests/fixtures/posthog_tracking_reference.cjs --check "$wave/tracking"
node tests/fixtures/posthog_lossless_reference.cjs --write "$wave/transport"
node tests/fixtures/posthog_lossless_reference.cjs --check "$wave/transport"
node tests/fixtures/posthog_tracking_benchmark.cjs --write "$wave/benchmark"
sha256sum "$wave/benchmark/input.json" > "$wave/benchmark-input-before.sha256"

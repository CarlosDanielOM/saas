set -eu
wave=/artifacts/posthog-receipt/attempt2
export POSTHOG_TRACKING_FIXTURES="$wave/tracking"
export POSTHOG_LOSSLESS_REFERENCE_DIR="$wave/transport"
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$wave/parser"
export DIMA_AI_RECEIPT_NODE_ROOT=/artifacts/posthog-receipt/attempt1/node-provenance/root
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export TZ=UTC
features=posthog-tracking,ai-usage-receipt-parser,ai-usage-producer
sha256sum "$wave/parser/ai_usage_receipt_parser_reference.json" "$wave/tracking/posthog_tracking.json" "$wave/transport/reference.json" "$wave/benchmark/input.json" "$wave/benchmark/node-report.json" > "$wave/compiler-fixtures-before.sha256"
cargo fmt --all -- --check
cargo check --locked --no-default-features --all-targets
for feature in posthog-lossless posthog-tracking lossless-json-view ai-usage-receipt-parser posthog-benchmark; do
  cargo check --locked --no-default-features --features "$feature" --all-targets
done
cargo check --locked --all-targets --all-features
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --no-default-features --features "$features" --lib --test posthog_tracking --test posthog_lossless --test ai_usage_receipt_parser --test lossless_json_view -- --nocapture
cargo test --locked --no-default-features --features "$features" --test posthog_tracking -- --ignored --nocapture
# All five timezones already passed with these exact 32 parser source inputs.
# The stored source-reuse audit and fresh Node check bind that proof. Recheck UTC
# after the unrelated SDK boxing and transport condition Clippy corrections.
cargo test --locked --no-default-features --features "$features" --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact --nocapture
sha256sum "$wave/parser/ai_usage_receipt_parser_reference.json" "$wave/tracking/posthog_tracking.json" "$wave/transport/reference.json" "$wave/benchmark/input.json" "$wave/benchmark/node-report.json" > "$wave/compiler-fixtures-after.sha256"
cmp "$wave/compiler-fixtures-before.sha256" "$wave/compiler-fixtures-after.sha256"
export POSTHOG_BENCH_DIR="$wave/benchmark"
export POSTHOG_BENCH_INPUT_SHA256=__PARENT_SHA256__
cargo test --release --locked --no-default-features --features posthog-benchmark --test posthog_tracking_benchmark -- --ignored --exact prepared_payload_benchmark --nocapture
sha256sum "$wave/benchmark/input.json" > "$wave/benchmark-input-after.sha256"
cmp "$wave/benchmark-input-before.sha256" "$wave/benchmark-input-after.sha256"

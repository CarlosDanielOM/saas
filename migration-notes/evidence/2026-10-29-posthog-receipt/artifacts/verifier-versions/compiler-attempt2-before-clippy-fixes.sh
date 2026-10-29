set -eu
wave=/artifacts/posthog-receipt/attempt1
export POSTHOG_TRACKING_FIXTURES="$wave/tracking"
export POSTHOG_LOSSLESS_REFERENCE_DIR="$wave/transport"
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$wave/parser"
export DIMA_AI_RECEIPT_NODE_ROOT="$wave/node-provenance/root"
export DIMA_AI_RECEIPT_NODE_BINARY="$wave/node-provenance/node"
export TZ=UTC
features=posthog-tracking,ai-usage-receipt-parser,ai-usage-producer
sha256sum "$wave/parser/ai_usage_receipt_parser_reference.json" "$wave/tracking/posthog_tracking.json" "$wave/transport/reference.json" "$wave/benchmark/input.json" "$wave/benchmark/node-report.json" > "$wave/compiler-fixtures-before.sha256"
cargo fmt --all -- --check
cargo check --locked --no-default-features --all-targets
cargo test --locked --no-default-features --features "$features" --lib --test posthog_tracking --test posthog_lossless --test ai_usage_receipt_parser --test lossless_json_view -- --nocapture
cargo test --locked --no-default-features --features "$features" --test posthog_tracking -- --ignored --nocapture
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
  TZ="$zone" cargo test --locked --no-default-features --features "$features" --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact --nocapture
done
for feature in posthog-lossless posthog-tracking lossless-json-view ai-usage-receipt-parser posthog-benchmark; do
  cargo check --locked --no-default-features --features "$feature" --all-targets
done
cargo check --locked --all-targets --all-features
cargo clippy --locked --all-targets --all-features -- -D warnings
sha256sum "$wave/parser/ai_usage_receipt_parser_reference.json" "$wave/tracking/posthog_tracking.json" "$wave/transport/reference.json" "$wave/benchmark/input.json" "$wave/benchmark/node-report.json" > "$wave/compiler-fixtures-after.sha256"
cmp "$wave/compiler-fixtures-before.sha256" "$wave/compiler-fixtures-after.sha256"
export POSTHOG_BENCH_DIR="$wave/benchmark"
POSTHOG_BENCH_INPUT_SHA256=$(cut -d ' ' -f1 "$wave/benchmark-input-before.sha256")
export POSTHOG_BENCH_INPUT_SHA256
cargo test --release --locked --no-default-features --features posthog-benchmark --test posthog_tracking_benchmark -- --ignored --exact prepared_payload_benchmark --nocapture
sha256sum "$wave/benchmark/input.json" > "$wave/benchmark-input-after.sha256"
cmp "$wave/benchmark-input-before.sha256" "$wave/benchmark-input-after.sha256"

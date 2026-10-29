set -eu
export TZ=UTC
wave=/artifacts/receipt-parser-benchmark/attempt3
export AI_RECEIPT_BENCH_DIR="$wave/benchmark"
export AI_RECEIPT_BENCH_INPUT_SHA256=cb08aecfc1c81aad5b062e952450356ca17aec186e9f4881418ed4a68906980e
export AI_RECEIPT_BENCH_RUSTC_VERSION="$(rustc --version)"
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/ai-credit-receipt/runtime-provenance/node
export DIMA_AI_RECEIPT_TYPESCRIPT_IMPLEMENTATION=/artifacts/ai-credit-receipt/runtime-provenance/typescript
export DIMA_AI_RECEIPT_TYPESCRIPT_PACKAGE=/artifacts/ai-credit-receipt/runtime-provenance/typescriptPackage
cargo test --release --locked --offline --no-default-features --features ai-usage-receipt-parser --test ai_usage_receipt_parser_benchmark prepared_receipt_parser_benchmark -- --ignored --exact --nocapture
sh /task-tools/receipt_lookup_profile3.sh
sha256sum /target-cache/release/deps/libdima_rust-876f99c816a4cba7.rlib > /artifacts/receipt-parser-benchmark/lookup-diagnostic-attempt3/rlib.sha256
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$wave/parser"
export DIMA_AI_RECEIPT_NODE_ROOT=/artifacts/posthog-receipt/attempt1/node-provenance/root
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
find "$wave" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/replay-before.sha256"
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
 TZ="$zone" cargo test --release --locked --offline --no-default-features --features ai-usage-receipt-parser,ai-usage-producer --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact --nocapture
done
find "$wave" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/replay-after.sha256"
cmp "$wave/replay-before.sha256" "$wave/replay-after.sha256"

export POSTHOG_TRACKING_FIXTURES="$wave/tracking"
export POSTHOG_LOSSLESS_REFERENCE_DIR="$wave/transport"
export DIMA_AI_USAGE_PRODUCER_FIXTURE_DIR="$wave/producer"
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-wire20261029native1:
export DIMA_AI_PROJECTION_REFERENCE_DIR="$wave/projection"
export DIMA_AI_PROJECTION_NODE_BINARY=/artifacts/ai-credit-receipt/runtime-provenance/node
export DIMA_AI_PROJECTION_TYPESCRIPT_IMPLEMENTATION=/artifacts/ai-credit-receipt/runtime-provenance/typescript
export DIMA_AI_PROJECTION_TYPESCRIPT_PACKAGE=/artifacts/ai-credit-receipt/runtime-provenance/typescriptPackage
export DIMA_TTS_USAGE_FIXTURE_DIR="$wave/pricing"
features=posthog-tracking,ai-usage-receipt-parser,ai-usage-producer,ai-credit-projection
cargo test --locked --offline --no-default-features --features "$features" --test posthog_tracking --test posthog_lossless --test ai_usage_producer --test ai_credit_projection --test tts_usage_pricing -- --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test posthog_tracking -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test ai_usage_producer replay_actual_source_fixture -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test ai_credit_projection replay_every_actual_source_case -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features "$features" --test tts_usage_pricing actual_source_pricing -- --ignored --exact --nocapture

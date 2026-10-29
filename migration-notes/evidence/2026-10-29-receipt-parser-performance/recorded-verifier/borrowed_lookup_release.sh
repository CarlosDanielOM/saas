set -eu
export TZ=UTC
wave=/artifacts/receipt-parser-benchmark/attempt2
export AI_RECEIPT_BENCH_DIR="$wave/benchmark"
export AI_RECEIPT_BENCH_INPUT_SHA256=4833733d9eee157f17b0095315d8dc6ffea034a5b305e52834ac8b1087b91653
export AI_RECEIPT_BENCH_RUSTC_VERSION="$(rustc --version)"
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/ai-credit-receipt/runtime-provenance/node
export DIMA_AI_RECEIPT_TYPESCRIPT_IMPLEMENTATION=/artifacts/ai-credit-receipt/runtime-provenance/typescript
export DIMA_AI_RECEIPT_TYPESCRIPT_PACKAGE=/artifacts/ai-credit-receipt/runtime-provenance/typescriptPackage
cargo test --release --locked --offline --no-default-features --features ai-usage-receipt-parser --test ai_usage_receipt_parser_benchmark prepared_receipt_parser_benchmark -- --ignored --exact --nocapture
sh /task-tools/receipt_lookup_profile2.sh
sha256sum /target-cache/release/deps/libdima_rust-876f99c816a4cba7.rlib > /artifacts/receipt-parser-benchmark/lookup-diagnostic-attempt2/rlib.sha256
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$wave/parser"
export DIMA_AI_RECEIPT_NODE_ROOT=/artifacts/posthog-receipt/attempt1/node-provenance/root
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
find "$wave" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/replay-before.sha256"
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
 TZ="$zone" cargo test --release --locked --offline --no-default-features --features ai-usage-receipt-parser,ai-usage-producer --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact --nocapture
done
find "$wave" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/replay-after.sha256"
cmp "$wave/replay-before.sha256" "$wave/replay-after.sha256"

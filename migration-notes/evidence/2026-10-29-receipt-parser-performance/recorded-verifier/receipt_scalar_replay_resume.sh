set -eu
export TZ=UTC
wave=/artifacts/receipt-parser-benchmark/attempt4
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$wave/parser"
export DIMA_AI_RECEIPT_NODE_ROOT=/artifacts/posthog-receipt/attempt1/node-provenance/root
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
find "$wave/parser" "$wave/benchmark" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/replay-resume-before.sha256"
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
 TZ="$zone" cargo test --release --locked --offline --no-default-features --features ai-usage-receipt-parser,ai-usage-producer --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact --nocapture
done
find "$wave/parser" "$wave/benchmark" -name '*.json' -type f -exec sha256sum {} \; | sort > "$wave/replay-resume-after.sha256"
cmp "$wave/replay-resume-before.sha256" "$wave/replay-resume-after.sha256"

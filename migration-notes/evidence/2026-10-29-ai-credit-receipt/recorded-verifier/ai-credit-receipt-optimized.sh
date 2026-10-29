cargo fmt --all -- --check
export DIMA_AI_USAGE_PRODUCER_FIXTURE_DIR=/artifacts/ai-credit-receipt/producer
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-20261029validation1:
find /artifacts/ai-credit-receipt -type f -exec sha256sum {} \; | sort > /artifacts/ai-credit-receipt-optimized-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features ai-usage-producer --lib --test ai_usage_producer --test ai_usage_producer_redis
cargo test --locked --offline --no-default-features --features ai-usage-producer --test ai_usage_producer replay_actual_source_fixture -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features ai-usage-producer --test ai_usage_producer_redis -- --ignored --nocapture --test-threads=1
cargo check --locked --offline --all-targets --no-default-features --features ai-usage-producer
cargo clippy --locked --offline --all-targets --no-default-features --features ai-usage-producer -- -D warnings
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
find /artifacts/ai-credit-receipt -type f -exec sha256sum {} \; | sort > /artifacts/ai-credit-receipt-optimized-fixtures-after.sha256
cmp /artifacts/ai-credit-receipt-optimized-fixtures-before.sha256 /artifacts/ai-credit-receipt-optimized-fixtures-after.sha256
input_file=/artifacts/ai-credit-receipt/producer-benchmark/ai-usage-producer-benchmark-input.json
sha256sum "$input_file" > /artifacts/ai-credit-receipt-optimized-benchmark-before.sha256
input_sha=$(cut -d ' ' -f 1 /artifacts/ai-credit-receipt-optimized-benchmark-before.sha256)
DIMA_AI_USAGE_PRODUCER_BENCHMARK_DIR=/artifacts/ai-credit-receipt/producer-benchmark DIMA_AI_USAGE_PRODUCER_INPUT_SHA256="$input_sha" cargo test --release --locked --offline --no-default-features --features ai-usage-producer --test ai_usage_producer_benchmark matched_prepared_receipts -- --ignored --exact --nocapture
sha256sum "$input_file" > /artifacts/ai-credit-receipt-optimized-benchmark-after.sha256
cmp /artifacts/ai-credit-receipt-optimized-benchmark-before.sha256 /artifacts/ai-credit-receipt-optimized-benchmark-after.sha256

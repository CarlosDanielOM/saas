cargo fmt --all -- --check
export DIMA_AI_PROJECTION_REFERENCE_DIR=/artifacts/ai-credit-receipt/projection
export DIMA_AI_PROJECTION_NODE_BINARY=/artifacts/ai-credit-receipt/runtime-provenance/node
export DIMA_AI_PROJECTION_TYPESCRIPT_IMPLEMENTATION=/artifacts/ai-credit-receipt/runtime-provenance/typescript
export DIMA_AI_PROJECTION_TYPESCRIPT_PACKAGE=/artifacts/ai-credit-receipt/runtime-provenance/typescriptPackage
export DIMA_AI_USAGE_PRODUCER_FIXTURE_DIR=/artifacts/ai-credit-receipt/producer
export DIMA_AI_USAGE_PRODUCER_NAMESPACE=producer-fixture-20261029validation1:
find /artifacts/ai-credit-receipt -type f -exec sha256sum {} \; | sort > /artifacts/ai-credit-receipt-fixtures-before.sha256
cargo test --locked --offline --no-default-features --features ai-credit-projection,ai-usage-producer --lib --test ai_credit_projection --test ai_credit_projection_redis --test ai_usage_producer --test ai_usage_producer_redis
cargo test --locked --offline --no-default-features --features ai-credit-projection --test ai_credit_projection replay_every_actual_source_case -- --ignored --exact --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features ai-credit-projection --test ai_credit_projection_redis -- --ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features ai-usage-producer --test ai_usage_producer replay_actual_source_fixture -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features ai-usage-producer --test ai_usage_producer_redis -- --ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features chat-message,timer-policy,credit-policy --test policy_utils_parity
cargo test --locked --offline --no-default-features --features tts-services,channel-tts-settings --lib --test expressive_tag_types --test expressive_lossless --test expressive_source --test tts_utilities --test tts_credit_fallback --test js_string --test channel_tts_settings_normalization --test channel_tts_settings_schema --test tts_providers --test piper_tts --test kokoro_tts --test tts_runtime --test tts_usage_pricing
cargo check --locked --offline --all-targets --no-default-features --features ai-credit-projection
cargo clippy --locked --offline --all-targets --no-default-features --features ai-credit-projection -- -D warnings
cargo check --locked --offline --all-targets --no-default-features --features ai-usage-producer
cargo clippy --locked --offline --all-targets --no-default-features --features ai-usage-producer -- -D warnings
cargo check --locked --offline --all-targets --all-features
cargo clippy --locked --offline --all-targets --all-features -- -D warnings
cargo check --locked --offline --all-targets --no-default-features
find /artifacts/ai-credit-receipt -type f -exec sha256sum {} \; | sort > /artifacts/ai-credit-receipt-fixtures-after.sha256
cmp /artifacts/ai-credit-receipt-fixtures-before.sha256 /artifacts/ai-credit-receipt-fixtures-after.sha256
input_file=/artifacts/ai-credit-receipt/producer-benchmark/ai-usage-producer-benchmark-input.json
sha256sum "$input_file" > /artifacts/ai-credit-receipt-benchmark-before.sha256
input_sha=$(cut -d ' ' -f 1 /artifacts/ai-credit-receipt-benchmark-before.sha256)
DIMA_AI_USAGE_PRODUCER_BENCHMARK_DIR=/artifacts/ai-credit-receipt/producer-benchmark DIMA_AI_USAGE_PRODUCER_INPUT_SHA256="$input_sha" cargo test --release --locked --offline --no-default-features --features ai-usage-producer --test ai_usage_producer_benchmark matched_prepared_receipts -- --ignored --exact --nocapture
sha256sum "$input_file" > /artifacts/ai-credit-receipt-benchmark-after.sha256
cmp /artifacts/ai-credit-receipt-benchmark-before.sha256 /artifacts/ai-credit-receipt-benchmark-after.sha256

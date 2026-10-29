set -eu
export TZ=UTC
export AI_RECEIPT_BENCH_DIR=/artifacts/receipt-parser-benchmark/attempt1/benchmark
export AI_RECEIPT_BENCH_INPUT_SHA256=2342386c3dde9f63206402cd7e82d83b88360f9cbab7d90ef69ee5a52e0e287e
export AI_RECEIPT_BENCH_RUSTC_VERSION="$(rustc --version)"
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/ai-credit-receipt/runtime-provenance/node
export DIMA_AI_RECEIPT_TYPESCRIPT_IMPLEMENTATION=/artifacts/ai-credit-receipt/runtime-provenance/typescript
export DIMA_AI_RECEIPT_TYPESCRIPT_PACKAGE=/artifacts/ai-credit-receipt/runtime-provenance/typescriptPackage
cargo test --release --locked --offline --no-default-features --features ai-usage-receipt-parser --test ai_usage_receipt_parser_benchmark prepared_receipt_parser_benchmark -- --ignored --exact --nocapture
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets

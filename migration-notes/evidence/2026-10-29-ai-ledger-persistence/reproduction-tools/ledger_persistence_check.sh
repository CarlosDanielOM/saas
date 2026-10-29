set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features ai-usage --test ai_usage_category_policy
cargo check --locked --offline --no-default-features --features ai-usage-ledger-persistence --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --bin ai_usage_receipts
cargo test --locked --offline --no-default-features --features ai-usage-ledger-persistence,ai-usage-ledger-queries,ai-usage-retention --test ai_usage_ledger_persistence --test ai_usage_producer --test ai_usage_receipt_parser --test ai_usage_ledger_queries --test ai_usage_retention -- --nocapture
cargo test --locked --offline --no-default-features --features mongo,redis --lib aggregate_shapes_preserve_adjustment_debits_and_credit_sign -- --nocapture
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets

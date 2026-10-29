set -eu
cargo fmt --all -- --check
cargo check --locked --offline --no-default-features --features ai-usage-ledger-queries --all-targets
cargo check --locked --offline --no-default-features --features ai-usage-retention --all-targets
cargo test --locked --offline --no-default-features --features ai-usage-ledger-queries,ai-usage-retention --test ai_usage_ledger_queries --test ai_usage_retention -- --nocapture
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets

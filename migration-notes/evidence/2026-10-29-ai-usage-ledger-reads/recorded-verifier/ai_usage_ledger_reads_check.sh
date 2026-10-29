set -eu
cargo fmt --all -- --check
cargo check --locked --offline --no-default-features --features ai-usage-ledger-reads --all-targets
cargo test --locked --offline --no-default-features --features ai-usage-ledger-reads --test ai_usage_ledger_reads -- --nocapture
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets

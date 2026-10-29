set -eu
cargo fmt --all -- --check
cargo check --locked --offline --no-default-features --features ai-usage-receipt-parser --all-targets
cargo clippy --locked --offline --no-default-features --features ai-usage-receipt-parser --all-targets -- -D warnings

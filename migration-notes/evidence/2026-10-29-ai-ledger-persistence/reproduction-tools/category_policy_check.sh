set -eu
cargo clippy --locked --offline --no-default-features --features ai-usage-ledger-queries --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets

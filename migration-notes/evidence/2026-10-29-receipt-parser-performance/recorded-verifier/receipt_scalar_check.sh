set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features ai-usage-receipt-parser --lib utils::lossless_json::tests -- --nocapture
cargo test --locked --offline --no-default-features --features ai-usage-receipt-parser --lib utils::lossless_json_view::tests -- --nocapture
cargo test --locked --offline --no-default-features --features ai-usage-receipt-parser --test lossless_json_view --test ai_usage_receipt_parser -- --nocapture
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets

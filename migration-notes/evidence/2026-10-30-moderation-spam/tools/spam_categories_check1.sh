set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-spam-categories --all-targets -- -D warnings
cargo test --locked --offline --no-default-features --features moderation-spam-categories --test moderation_spam_categories

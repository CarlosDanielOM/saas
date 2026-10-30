set -eu
export DIMA_SPAM_CATEGORIES_REFERENCE=/artifacts/moderation-spam-categories/attempt2/reference/moderation_spam_categories_reference.json
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-spam-categories --all-targets -- -D warnings
cargo test --locked --offline --no-default-features --features moderation-spam-categories --test moderation_spam_categories -- --include-ignored --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-links,moderation-normalize --all-targets -- -D warnings
cargo test --locked --offline --no-default-features --features moderation-links,moderation-normalize --test moderation_links --test moderation_normalize

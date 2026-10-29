set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-permit --all-targets -- -D warnings
cargo test --locked --offline --no-default-features --features moderation-permit --test moderation_permit
cargo test --locked --offline --no-default-features --features moderation-permit --lib moderation::permit

set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-offenses --test moderation_offenses
cargo test --locked --offline --no-default-features --features moderation-offenses --lib utils::moderation::offenses
cargo clippy --locked --offline --no-default-features --features moderation-offenses --all-targets -- -D warnings

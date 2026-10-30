set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-variation-jobs --test moderation_variation_schema --test moderation_variations --test moderation_variations_provider
cargo clippy --locked --offline --no-default-features --features moderation-variation-jobs --all-targets --keep-going -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets --keep-going -- -D warnings

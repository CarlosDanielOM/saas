set -eu
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-seed-plan --test moderation_seed_plan
cargo clippy --locked --offline --no-default-features --features moderation-seed-plan --all-targets -- -D warnings

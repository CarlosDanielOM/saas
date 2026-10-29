set -eu
export DIMA_SEED_PLAN_FIXTURE_DIR=/artifacts/moderation-seed-plan/attempt1/reference
export DIMA_SEED_PLAN_FIXTURE_SHA256=09efa8c6312cf99fa60e6f6d9a324d652ab9ba87a70509a5135c039809f6c044
cargo test --locked --offline --no-default-features --features moderation-seed-plan --test moderation_seed_plan -- --ignored --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

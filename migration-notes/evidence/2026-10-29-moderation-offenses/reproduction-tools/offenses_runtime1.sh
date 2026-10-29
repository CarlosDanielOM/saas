set -eu
export DIMA_OFFENSE_FIXTURE_DIR=/artifacts/moderation-offenses/attempt1/reference
export DIMA_OFFENSE_FIXTURE_SHA256=b7bf7bb80d0d7169be41f8aa47e90ec9436ac216621ab6cf6cba95dbe3ee809c
cargo test --locked --offline --no-default-features --features moderation-offenses --test moderation_offenses -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features moderation-offenses --test moderation_offenses_redis -- --ignored --nocapture --test-threads=1
cargo test --locked --offline --no-default-features --features moderation-permit,moderation-offenses --test moderation_permit
cargo test --locked --offline --no-default-features --features moderation-permit,moderation-offenses --lib utils::moderation
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

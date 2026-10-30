set -eu
export DIMA_PERMIT_FIXTURE_DIR=/artifacts/redis-application-runtime/attempt1/permit-reference
export DIMA_PERMIT_FIXTURE_SHA256=7aac5f38a8d8ba5b36926bcbdc59c4e3461421a56e1371be8184f5adfa5c00fc
export DIMA_OFFENSE_FIXTURE_DIR=/artifacts/redis-application-runtime/attempt1/offenses-reference
export DIMA_OFFENSE_FIXTURE_SHA256=8bda32e9b7f15f473421876aa0e3ba8b084159ee32500144000e21c36476205e
cargo test --locked --offline --no-default-features --features moderation-permit,moderation-offenses --test moderation_permit --test moderation_offenses
cargo test --locked --offline --no-default-features --features moderation-permit,moderation-offenses --test moderation_permit --test moderation_offenses -- --ignored --nocapture
cargo test --locked --offline --no-default-features --features moderation-permit,moderation-offenses --lib utils::moderation
cargo test --locked --offline --no-default-features --features moderation-permit,moderation-offenses --test moderation_permit_redis --test moderation_offenses_redis -- --ignored --test-threads=1
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

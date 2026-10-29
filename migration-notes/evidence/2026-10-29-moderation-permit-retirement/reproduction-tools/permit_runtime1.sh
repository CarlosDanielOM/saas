set -eu
export DIMA_PERMIT_FIXTURE_DIR=/artifacts/moderation-permit/attempt1/reference
export DIMA_PERMIT_FIXTURE_SHA256=1f194af76c739062e8d11ff1189de938507ffcf394c4bdaf4f3f4643dbc6146c
cargo test --locked --offline --no-default-features --features moderation-permit --test moderation_permit replay_actual_permit_source -- --ignored --exact --nocapture
cargo test --locked --offline --no-default-features --features moderation-permit --test moderation_permit_redis -- --ignored --nocapture --test-threads=1
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

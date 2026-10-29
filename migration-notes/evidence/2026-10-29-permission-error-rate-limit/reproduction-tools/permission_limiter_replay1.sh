set -eu
export PERMISSION_ERROR_REFERENCE_DIR=/artifacts/permission-error-limiter/attempt1/reference
cargo test --locked --offline --no-default-features --features permissions --test permission_error_rate_limit replay_actual_source -- --ignored --exact --nocapture
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

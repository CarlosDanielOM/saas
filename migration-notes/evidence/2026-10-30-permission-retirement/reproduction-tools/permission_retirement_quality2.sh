set -eu
export PERMISSION_ERROR_REFERENCE_DIR=/artifacts/permission-retirement/attempt2/reference
export PERMISSION_ERROR_REFERENCE_SHA256=3dfe38fdb78816861c438311defde8c738a28134898fdab388039c0a0750c130
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features permissions --test permission_error_rate_limit -- --include-ignored --nocapture
cargo clippy --locked --offline --no-default-features --features permissions --lib --test permission_error_rate_limit -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

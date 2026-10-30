set -eu
export PERMISSION_ERROR_REFERENCE_DIR=/artifacts/permission-retirement/attempt1/reference
export PERMISSION_ERROR_REFERENCE_SHA256=89a854cd91ea8006ba08361d5b6189e2380facfb8614f15de23ad54f3bfd04dc
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features permissions --test permission_error_rate_limit -- --include-ignored --nocapture
cargo clippy --locked --offline --no-default-features --features permissions --lib --test permission_error_rate_limit -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

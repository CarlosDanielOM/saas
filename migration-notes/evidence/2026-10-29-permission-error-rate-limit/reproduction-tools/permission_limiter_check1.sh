set -eu
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features permissions --lib --test permission_error_rate_limit -- -D warnings
cargo test --locked --offline --no-default-features --features permissions --test permission_error_rate_limit
cargo test --locked --offline --no-default-features --features permissions --lib

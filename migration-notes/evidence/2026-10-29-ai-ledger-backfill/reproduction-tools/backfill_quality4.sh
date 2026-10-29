set -eu
cargo fmt --all -- --check
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --all-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

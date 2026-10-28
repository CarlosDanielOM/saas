set -eu
# Drop only this package's task-owned outputs before the broader feature audit.
# Shared dependencies remain warm and the private cache stays below its 8 GiB ceiling.
cargo clean --locked --package dima-rust
cargo fmt --all -- --check
cargo check --locked --offline --keep-going --all-targets --all-features
cargo clippy --locked --offline --keep-going --all-targets --all-features -- -D warnings
cargo test --locked --offline --no-default-features --features credential-crypto,jwt --test credential_activation
cargo check --locked --offline --all-targets --no-default-features

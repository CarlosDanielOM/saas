#!/bin/sh
# Only invoked by saas-ops inside its verified, capped, task-owned compiler.
set -eu

# Pin the image's installed toolchain instead of allowing rust-toolchain.toml
# to select/download a moving stable compiler during this release.
RUSTUP_TOOLCHAIN="$(rustup default | cut -d ' ' -f 1)"
export RUSTUP_TOOLCHAIN
rustc -vV > /artifacts/toolchain.txt
grep -q '^host: .*unknown-linux-musl$' /artifacts/toolchain.txt

# Native dependencies and linker installation are inside the same hard caps.
apk add --no-cache build-base
rustup component add --toolchain "$RUSTUP_TOOLCHAIN" rustfmt clippy
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo build --locked --release --bin stream_activity --example stream_activity_fixture
install -m 0755 /work/target/release/stream_activity /artifacts/stream_activity
install -m 0755 /work/target/release/examples/stream_activity_fixture /artifacts/stream_activity_fixture
# This exercises the actual release binary with no database/environment needed.
/artifacts/stream_activity --dry-run

#!/bin/sh
# Only invoked by saas-ops inside its verified, capped, task-owned compiler.
set -eu
SAAS_RUST_FEATURES="${SAAS_RUST_FEATURES:-mongo}"
case "$SAAS_RUST_FEATURES" in
  mongo) ;;
  *) echo 'Unsupported worker features; review the dependency graph guard before enabling another profile' >&2; exit 1 ;;
esac
SAAS_RUST_BASELINE_FEATURES="${SAAS_RUST_BASELINE_FEATURES:-mongo,redis}"
case "$SAAS_RUST_BASELINE_FEATURES" in
  mongo,redis) ;;
  *) echo 'Unsupported baseline features; review the dependency graph guard before enabling another profile' >&2; exit 1 ;;
esac

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

# Explicit transition audit only. Keep the future server/database feature graph
# out of ordinary worker builds and out of their persistent target cache.
case "${SAAS_RUST_FEATURE_MATRIX:-0}" in
  0) ;;
  1)
    cargo check --locked --target-dir /work/feature-matrix --all-targets --no-default-features
    for feature in redis postgres http; do
      cargo check --locked --target-dir /work/feature-matrix --all-targets --no-default-features --features "$feature"
    done
    cargo check --locked --target-dir /work/feature-matrix --all-targets --all-features
    cargo test --locked --target-dir /work/feature-matrix --no-default-features --features redis --lib tls_configuration_has_a_provider_without_other_database_features
    ;;
  *) echo 'Invalid feature matrix mode' >&2; exit 1 ;;
esac

# Cache dependencies, never trust previously built project executables. Rebuild
# our package against this run's frozen read-only /source on every invocation.
cargo clean --locked --package dima-rust
cargo tree --locked --no-default-features --features "$SAAS_RUST_FEATURES" --edges normal --prefix none --format '{p}' > /artifacts/worker-dependencies.txt
if grep -Eq '^(sqlx(-[^ ]+)?|axum(-[^ ]+)?|redis) v' /artifacts/worker-dependencies.txt; then
    echo 'Mongo worker dependency graph unexpectedly includes SQLx, Axum, or Redis' >&2
    exit 1
fi
cargo check --locked --all-targets --no-default-features --features "$SAAS_RUST_FEATURES"
cargo clippy --locked --all-targets --no-default-features --features "$SAAS_RUST_FEATURES" -- -D warnings
cargo test --locked --no-default-features --features "$SAAS_RUST_FEATURES"
cargo build --locked --release --no-default-features --features "$SAAS_RUST_FEATURES" --bin stream_activity --bin raid_analytics --bin roulette_completion
install -m 0755 /target-cache/release/stream_activity /artifacts/stream_activity
install -m 0755 /target-cache/release/raid_analytics /artifacts/raid_analytics
install -m 0755 /target-cache/release/roulette_completion /artifacts/roulette_completion
# Build sequentially in this same capped compiler. Copy the Mongo-only release
# outputs first: enabling Redis must never replace those installed artifacts.
cargo tree --locked --no-default-features --features "$SAAS_RUST_BASELINE_FEATURES" --edges normal --prefix none --format '{p}' > /artifacts/baseline-worker-dependencies.txt
if grep -Eq '^(sqlx(-[^ ]+)?|axum(-[^ ]+)?) v' /artifacts/baseline-worker-dependencies.txt; then
    echo 'Baseline worker dependency graph unexpectedly includes SQLx or Axum' >&2
    exit 1
fi
cargo check --locked --all-targets --no-default-features --features "$SAAS_RUST_BASELINE_FEATURES"
cargo clippy --locked --all-targets --no-default-features --features "$SAAS_RUST_BASELINE_FEATURES" -- -D warnings
cargo test --locked --no-default-features --features "$SAAS_RUST_BASELINE_FEATURES"
cargo build --locked --release --no-default-features --features "$SAAS_RUST_BASELINE_FEATURES" --bin follow_defense_baseline
install -m 0755 /target-cache/release/follow_defense_baseline /artifacts/follow_defense_baseline
# This exercises the actual release binary with no database/environment needed.
/artifacts/stream_activity --dry-run
/artifacts/raid_analytics --dry-run
/artifacts/roulette_completion --dry-run
/artifacts/follow_defense_baseline --dry-run

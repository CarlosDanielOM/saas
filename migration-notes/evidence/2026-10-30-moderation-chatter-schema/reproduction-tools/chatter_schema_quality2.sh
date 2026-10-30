#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export DIMA_CHATTER_SCHEMA_FIXTURE_DIR=/artifacts/chatter-schema/attempt2/oracle
export DIMA_CHATTER_SCHEMA_FIXTURE_SHA256=42a11d1ed626b0be9fac05e8afce671dce33b442da69f5a53905e4e201394358
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features moderation-spam --test moderation_chatter_schema -- --include-ignored --nocapture --test-threads=1
cargo clippy --locked --offline --no-default-features --features moderation-spam --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

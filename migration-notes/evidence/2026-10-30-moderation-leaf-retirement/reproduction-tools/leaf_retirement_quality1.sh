#!/bin/sh
set -eu
cd /source/dimabot
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-rules,moderation-seed-plan,moderation-decision-schema --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

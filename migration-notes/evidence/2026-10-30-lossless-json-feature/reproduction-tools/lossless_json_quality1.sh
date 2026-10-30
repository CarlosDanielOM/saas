#!/bin/sh
set -eu
cd /source/dimabot
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features lossless-json --lib utils::lossless_json
cargo test --locked --offline --no-default-features --features tts-utilities --lib
cargo clippy --locked --offline --no-default-features --features lossless-json --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings
cargo tree --locked --offline --no-default-features --features lossless-json -e features -i dima-rust

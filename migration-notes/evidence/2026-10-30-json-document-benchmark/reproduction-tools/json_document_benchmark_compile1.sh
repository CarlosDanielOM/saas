#!/bin/sh
set -eu
cd /source/dimabot
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features lossless-json --all-targets -- -D warnings
cargo test --release --locked --offline --no-default-features --features lossless-json --test lossless_json_document_benchmark --no-run

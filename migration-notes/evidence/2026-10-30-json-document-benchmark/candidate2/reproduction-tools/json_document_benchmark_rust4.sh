#!/bin/sh
set -eu
cd /source/dimabot
export DIMA_JSON_DOCUMENT_BENCH_INPUT_SHA256=0e2a49498e4b6e02ba04ce0fa8200889c3f5c6f7f7583fe7c0c2eef6aa74b54c
export DIMA_JSON_DOCUMENT_BENCH_PROVENANCE_SHA256=28f8ef20e0cacd381c4fadf174818c0c1748b829cdfef3eeaf72ed912c8f0a25
export DIMA_JSON_DOCUMENT_BENCH_DIR=/artifacts/json-document-optimized2/round4
cargo test --release --locked --offline --no-default-features --features lossless-json --test lossless_json_document_benchmark matched_parse_select_serialize_benchmark -- --ignored --exact --nocapture

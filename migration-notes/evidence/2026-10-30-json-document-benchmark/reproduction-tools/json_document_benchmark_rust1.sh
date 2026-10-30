#!/bin/sh
set -eu
cd /source/dimabot
export DIMA_JSON_DOCUMENT_BENCH_INPUT_SHA256=0e2a49498e4b6e02ba04ce0fa8200889c3f5c6f7f7583fe7c0c2eef6aa74b54c
export DIMA_JSON_DOCUMENT_BENCH_PROVENANCE_SHA256=17bdce824857127e76ab56d31451ac8a3a2903936436fa33522017ec9e5af280
export DIMA_JSON_DOCUMENT_BENCH_DIR=/artifacts/json-document-benchmark/round1
cargo test --release --locked --offline --no-default-features --features lossless-json --test lossless_json_document_benchmark matched_parse_select_serialize_benchmark -- --ignored --exact --nocapture

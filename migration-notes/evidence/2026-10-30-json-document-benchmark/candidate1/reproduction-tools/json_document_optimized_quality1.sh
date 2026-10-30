#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
base=/artifacts/json-document-optimized/oracles
export DIMA_JSON_DOCUMENT_ORACLE="$base/document/lossless-json-document-reference.json"
export DIMA_JSON_DOCUMENT_ORACLE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_JSON_DOCUMENT_ORACLE"],"rb").read()).hexdigest())')"
export DIMA_JSON_DOCUMENT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features lossless-json --test lossless_json_document
cargo test --release --locked --offline --no-default-features --features lossless-json --test lossless_json_document pinned_node_oracle_canonicalization -- --ignored --exact
cargo test --locked --offline --no-default-features --features ai-usage-ledger-queries --test lossless_json_view --test ai_usage_receipt_parser --test ai_usage_ledger_queries
export DIMA_AI_RECEIPT_NODE_ROOT="$base/parser-provenance/root"
export DIMA_AI_RECEIPT_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_USAGE_RECEIPT_PARSER_FIXTURE_DIR="$base/parser"
for zone in UTC America/New_York Europe/Berlin Australia/Lord_Howe Pacific/Apia; do
 TZ="$zone" cargo test --release --locked --offline --no-default-features --features ai-usage-ledger-queries --test ai_usage_receipt_parser replay_actual_source_parser_and_bson -- --ignored --exact
 done
export DIMA_AI_LEDGER_QUERIES_REFERENCE_DIR="$base/queries"
export DIMA_AI_LEDGER_QUERIES_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DIMA_AI_LEDGER_QUERIES_NODE_DEPENDENCY_ROOT="$base/queries-provenance/root"
cargo test --release --locked --offline --no-default-features --features ai-usage-ledger-queries --test ai_usage_ledger_queries actual_source_complete_replay -- --ignored --exact
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets

cargo test --locked --offline --no-default-features --features twitch-functions --test delete_twitch_message --test twitch_function_diagnostics --test twitch_functions
export DELETE_TWITCH_MESSAGE_FIXTURE=/artifacts/json-document-optimized/delete/delete_twitch_message_cases.json
export DELETE_TWITCH_MESSAGE_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DELETE_TWITCH_MESSAGE_FIXTURE"],"rb").read()).hexdigest())')"
export DELETE_TWITCH_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DELETE_TWITCH_TYPESCRIPT_JS=/artifacts/posthog-receipt/attempt1/node-provenance/root/node_modules/typescript/lib/typescript.js
export DELETE_TWITCH_TYPESCRIPT_PACKAGE=/artifacts/posthog-receipt/attempt1/node-provenance/root/node_modules/typescript/package.json
cargo test --release --locked --offline --no-default-features --features twitch-functions --test delete_twitch_message actual_source_fixture_replay_and_source_hash -- --ignored --exact
cargo clippy --locked --offline --no-default-features --features lossless-json --all-targets -- -D warnings
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

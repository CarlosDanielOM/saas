#!/bin/sh
set -eu
cd /source/dimabot
export DELETE_TWITCH_MESSAGE_FIXTURE=/artifacts/json-document-optimized/delete/delete_twitch_message_cases.json
export DELETE_TWITCH_MESSAGE_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DELETE_TWITCH_MESSAGE_FIXTURE"],"rb").read()).hexdigest())')"
export DELETE_TWITCH_NODE_BINARY=/artifacts/posthog-receipt/attempt1/node-provenance/node
export DELETE_TWITCH_TYPESCRIPT_JS=/artifacts/posthog-receipt/attempt1/node-provenance/root/node_modules/typescript/lib/typescript.js
export DELETE_TWITCH_TYPESCRIPT_PACKAGE=/artifacts/posthog-receipt/attempt1/node-provenance/root/node_modules/typescript/package.json
cargo test --release --locked --offline --no-default-features --features twitch-functions --test delete_twitch_message actual_source_fixture_replay_and_source_hash -- --ignored --exact
cargo clippy --locked --offline --no-default-features --features lossless-json --all-targets -- -D warnings
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

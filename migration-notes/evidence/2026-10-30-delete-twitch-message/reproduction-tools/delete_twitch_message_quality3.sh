#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/delete-twitch-message/attempt3
export DELETE_TWITCH_MESSAGE_FIXTURE="$base/oracle/delete_twitch_message_cases.json"
export DELETE_TWITCH_MESSAGE_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DELETE_TWITCH_MESSAGE_FIXTURE"],"rb").read()).hexdigest())')"
provenance=/artifacts/posthog-receipt/attempt1/node-provenance
export DELETE_TWITCH_NODE_BINARY="$provenance/node"
export DELETE_TWITCH_TYPESCRIPT_JS="$provenance/root/node_modules/typescript/lib/typescript.js"
export DELETE_TWITCH_TYPESCRIPT_PACKAGE="$provenance/root/node_modules/typescript/package.json"
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features twitch-functions --test delete_twitch_message --test twitch_functions
cargo test --locked --offline --no-default-features --features twitch-functions --test delete_twitch_message actual_source_fixture_replay_and_source_hash -- --ignored --exact
cargo clippy --locked --offline --no-default-features --features twitch-functions --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

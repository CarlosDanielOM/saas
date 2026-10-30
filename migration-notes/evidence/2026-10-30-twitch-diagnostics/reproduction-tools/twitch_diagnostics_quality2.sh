#!/bin/sh
set -eu
cd /source/dimabot
base=/artifacts/twitch-diagnostics/attempt2
export DELETE_TWITCH_MESSAGE_FIXTURE="$base/delete/delete_twitch_message_cases.json"
export DELETE_TWITCH_MESSAGE_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DELETE_TWITCH_MESSAGE_FIXTURE"],"rb").read()).hexdigest())')"
provenance=/artifacts/posthog-receipt/attempt1/node-provenance
export DELETE_TWITCH_NODE_BINARY="$provenance/node"
export DELETE_TWITCH_TYPESCRIPT_JS="$provenance/root/node_modules/typescript/lib/typescript.js"
export DELETE_TWITCH_TYPESCRIPT_PACKAGE="$provenance/root/node_modules/typescript/package.json"
export TWITCH_DIAGNOSTICS_ORACLE="$base/diagnostics/twitch_function_diagnostics.json"
export TWITCH_DIAGNOSTICS_ORACLE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["TWITCH_DIAGNOSTICS_ORACLE"],"rb").read()).hexdigest())')"
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features twitch-functions --test delete_twitch_message --test twitch_function_diagnostics --test twitch_functions
cargo test --locked --offline --no-default-features --features twitch-functions --test delete_twitch_message actual_source_fixture_replay_and_source_hash -- --ignored --exact
cargo test --locked --offline --no-default-features --features twitch-functions --test twitch_function_diagnostics actual_source_bot_wrapper_policy_oracle -- --ignored --exact
export DIMA_RUST_TEST_RESOURCE_OWNER=twitch-function-diagnostics
export TWITCH_DIAGNOSTICS_MONGO_URI=mongodb://keyword-mongo:27017
export TWITCH_DIAGNOSTICS_REDIS_URL=redis://keyword-redis:6379/
export TWITCH_DIAGNOSTICS_NAMESPACE=twitch-diagnostics-a17933673:
cargo test --locked --offline --no-default-features --features twitch-functions --test twitch_function_diagnostics native_bot_auth_diagnostics_and_mirror -- --ignored --exact --nocapture
cargo clippy --locked --offline --no-default-features --features twitch-functions --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

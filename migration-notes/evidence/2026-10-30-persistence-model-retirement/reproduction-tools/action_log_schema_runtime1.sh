#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_DIR=/artifacts/moderation-action-log-schema/attempt1/reference
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_ACTION_LOG_SCHEMA_FIXTURE_DIR"]+"/moderation-action-log-schema-reference.json","rb").read()).hexdigest())')"
cargo test --locked --offline --no-default-features --features moderation-action-log-schema --test moderation_action_log_schema
cargo test --locked --offline --no-default-features --features moderation-action-log-schema --test moderation_action_log_schema -- --ignored --test-threads=1 --nocapture
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-action-log-schema --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

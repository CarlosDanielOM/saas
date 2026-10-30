#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
base=/artifacts/timer-chat-schema-types/attempt1
export TIMER_CHAT_TYPES_FIXTURE="$base/oracle/timer-chat-schema-types-reference.json"
export TIMER_CHAT_TYPES_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["TIMER_CHAT_TYPES_FIXTURE"],"rb").read()).hexdigest())')"
cargo fmt --all -- --check
cargo test --locked --offline --no-default-features --features application-schemas --test timer_chat_schema_types --test additional_schemas
cargo test --locked --offline --no-default-features --features application-schemas --test timer_chat_schema_types source_oracle_and_bson_boundaries -- --ignored --exact
cargo clippy --locked --offline --no-default-features --features application-schemas --all-targets -- -D warnings
cargo check --locked --offline --no-default-features --all-targets
cargo check --locked --offline --no-default-features --features mongo,redis --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

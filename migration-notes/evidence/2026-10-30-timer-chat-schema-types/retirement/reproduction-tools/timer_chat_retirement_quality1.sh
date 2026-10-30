#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
base=/artifacts/timer-chat-retirement/attempt1
export TIMER_CHAT_TYPES_FIXTURE="$base/timer/timer-chat-schema-types-reference.json"
export TIMER_CHAT_TYPES_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["TIMER_CHAT_TYPES_FIXTURE"],"rb").read()).hexdigest())')"
export DIMA_ADDITIONAL_SCHEMAS_FIXTURE_DIR="$base/additional"
export DIMA_ADDITIONAL_SCHEMAS_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_ADDITIONAL_SCHEMAS_FIXTURE_DIR"]+"/additional-schemas-reference.json","rb").read()).hexdigest())')"
export DIMA_APPLICATION_SCHEMAS_FIXTURE_DIR="$base/application"
export DIMA_APPLICATION_SCHEMAS_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_APPLICATION_SCHEMAS_FIXTURE_DIR"]+"/application-schemas-reference.json","rb").read()).hexdigest())')"
export SCHEMA_NAMED_TYPES_FIXTURE="$base/named/schema-named-types-reference.json"
export SCHEMA_NAMED_TYPES_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["SCHEMA_NAMED_TYPES_FIXTURE"],"rb").read()).hexdigest())')"
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_DIR="$base/action"
export DIMA_ACTION_LOG_SCHEMA_FIXTURE_SHA256="$(python3 -c 'import hashlib,os; print(hashlib.sha256(open(os.environ["DIMA_ACTION_LOG_SCHEMA_FIXTURE_DIR"]+"/moderation-action-log-schema-reference.json","rb").read()).hexdigest())')"
cargo fmt --all -- --check
cargo clippy --locked --offline --no-default-features --features moderation-action-log-schema --all-targets -- -D warnings
cargo test --locked --offline --no-default-features --features moderation-action-log-schema --test timer_chat_schema_types --test additional_schemas --test application_schemas --test schema_named_types --test moderation_action_log_schema
cargo test --locked --offline --no-default-features --features application-schemas --test timer_chat_schema_types source_oracle_and_bson_boundaries -- --ignored --exact
cargo test --locked --offline --no-default-features --features application-schemas --test schema_named_types source_oracle_and_catalogs -- --ignored --exact
cargo test --locked --offline --no-default-features --features moderation-action-log-schema --test moderation_action_log_schema replay_actual_mongoose_source -- --ignored --exact
cargo check --locked --offline --no-default-features --all-targets
cargo clippy --locked --offline --all-features --all-targets -- -D warnings

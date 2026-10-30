#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
base=/artifacts/timer-chat-retirement/attempt1
mkdir -p "$base/additional" "$base/timer" "$base/application" "$base/named" "$base/action"
node tests/fixtures/schema_source_resolver.test.cjs
node tests/fixtures/additional_schemas_reference.mjs --check
node tests/fixtures/additional_schemas_reference.mjs --write "$base/additional"
node tests/fixtures/additional_schemas_reference.mjs --check "$base/additional"
node tests/fixtures/timer_chat_schema_types_reference.cjs --write "$base/timer"
node tests/fixtures/timer_chat_schema_types_reference.cjs --check "$base/timer"
node tests/fixtures/application_schemas_reference.mjs --check
node tests/fixtures/application_schemas_reference.mjs --write "$base/application"
node tests/fixtures/application_schemas_reference.mjs --check "$base/application"
node tests/fixtures/schema_named_types_reference.cjs --write "$base/named"
node tests/fixtures/schema_named_types_reference.cjs --check "$base/named"
node tests/fixtures/moderation_action_log_schema_reference.cjs --write "$base/action"
node tests/fixtures/moderation_action_log_schema_reference.cjs --check "$base/action"

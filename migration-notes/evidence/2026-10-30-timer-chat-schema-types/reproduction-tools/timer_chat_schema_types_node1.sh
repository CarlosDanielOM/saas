#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
base=/artifacts/timer-chat-schema-types/attempt1
mkdir -p "$base/oracle"
node tests/fixtures/additional_schemas_reference.mjs --check
node tests/fixtures/timer_chat_schema_types_reference.cjs --write "$base/oracle"
node tests/fixtures/timer_chat_schema_types_reference.cjs --check "$base/oracle"

#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
base=/artifacts/persistence-model-retirement/attempt1
mkdir "$base"
mkdir "$base/application" "$base/action"
node tests/fixtures/schema_source_resolver.test.cjs
node tests/fixtures/application_schemas_reference.mjs --check
node tests/fixtures/application_schemas_reference.mjs --write "$base/application"
node tests/fixtures/application_schemas_reference.mjs --check "$base/application"
node tests/fixtures/moderation_action_log_schema_reference.cjs --write "$base/action"
node tests/fixtures/moderation_action_log_schema_reference.cjs --check "$base/action"

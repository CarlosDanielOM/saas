#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
base=/artifacts/schema-named-types/attempt2
mkdir -p "$base/named" "$base/application"
node tests/fixtures/schema_named_types_reference.cjs --write "$base/named"
node tests/fixtures/schema_named_types_reference.cjs --check "$base/named"
node tests/fixtures/application_schemas_reference.mjs --check
node tests/fixtures/application_schemas_reference.mjs --write "$base/application"
node tests/fixtures/application_schemas_reference.mjs --check "$base/application"

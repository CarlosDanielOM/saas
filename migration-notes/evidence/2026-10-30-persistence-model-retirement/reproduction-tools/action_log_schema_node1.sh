#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
base=/artifacts/moderation-action-log-schema/attempt1
mkdir -p /artifacts/moderation-action-log-schema
mkdir "$base"
mkdir "$base/reference"
node tests/fixtures/moderation_action_log_schema_reference.cjs --write "$base/reference"
node tests/fixtures/moderation_action_log_schema_reference.cjs --check "$base/reference"

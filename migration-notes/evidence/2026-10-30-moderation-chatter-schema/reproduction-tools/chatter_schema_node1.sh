#!/bin/sh
set -eu
cd /source/dimabot
export DIMA_SCHEMA_SOURCE_ROOT=/source/dimabot
export DIMA_SCHEMA_NODE_SHA256=569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108
mkdir -p /artifacts/chatter-schema/attempt1/oracle
node tests/fixtures/moderation_chatter_schema_reference.cjs --write /artifacts/chatter-schema/attempt1/oracle
node tests/fixtures/moderation_chatter_schema_reference.cjs --check /artifacts/chatter-schema/attempt1/oracle

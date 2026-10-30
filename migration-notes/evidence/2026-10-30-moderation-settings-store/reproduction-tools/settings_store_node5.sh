#!/bin/sh
set -eu
cd /source/dimabot
export TZ=UTC
export DIMA_MODERATION_SOURCE_ROOT=/source/dimabot
export DIMA_BLACKLIST_SOURCE_ROOT=/source/dimabot
export DIMA_SETTINGS_REPLAY_CHANNEL=keyword-fixture-fca01b6f57a8:settings-store-20261030-😀-é
base=/artifacts/moderation-settings-store/attempt5
mkdir -p /artifacts/moderation-settings-store
mkdir "$base"
mkdir "$base/reference"
node tests/fixtures/moderation_settings_store_reference.cjs --write "$base/reference"
node tests/fixtures/moderation_settings_store_reference.cjs --check "$base/reference"
